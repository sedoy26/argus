#!/usr/bin/env bun
/**
 * Configure existing Railway services for GitHub repo + branch, monorepo roots,
 * config-as-code paths, and GitHub autodeploy — via Railway public GraphQL API.
 *
 * Prereqs:
 *   - API token in the environment only (never in railway.deploy.config.json):
 *       - Account/workspace: https://railway.com/account/tokens → `RAILWAY_API_TOKEN` (Bearer), or
 *       - Project token: project settings → `RAILWAY_PROJECT_ACCESS_TOKEN` (Project-Access-Token header).
 *   - Railway GitHub App installed with access to `githubRepo` (browser flow; cannot be done via this API).
 *
 * Usage:
 *   export RAILWAY_API_TOKEN="…"   # or RAILWAY_PROJECT_ACCESS_TOKEN for a project token
 *   export RAILWAY_PROJECT_ID="…"   # optional if set in railway.deploy.config.json as projectId
 *   export RAILWAY_ENVIRONMENT_ID="…" # optional Railway *environment* UUID (not your API key)
 *   cp scripts/railway/railway.deploy.config.example.json scripts/railway/railway.deploy.config.json
 *   # edit githubRepo + matchName strings to match your Railway service names
 *   bun run scripts/railway/configure-github-autodeploy.ts
 *   bun run scripts/railway/configure-github-autodeploy.ts --dry-run
 *   bun run scripts/railway/configure-github-autodeploy.ts --list
 *   bun run scripts/railway/configure-github-autodeploy.ts --deploy   # trigger deploy from latest commit after updates
 */

const GQL = 'https://backboard.railway.com/graphql/v2';

type GqlErr = { message: string };
type GqlResp<T> = { data?: T; errors?: GqlErr[] };

type ServiceEdge = { node: { id: string; name: string } };
type EnvEdge = { node: { id: string; name: string } };

type DeployConfig = {
  /** Optional; else use `RAILWAY_PROJECT_ID` env. */
  projectId?: string;
  /** Optional; else match `environmentName` / `RAILWAY_ENVIRONMENT_NAME`, or first env. */
  environmentId?: string;
  githubRepo: string;
  branch: string;
  environmentName?: string;
  services: Array<{
    matchName: string;
    rootDirectory: string;
    railwayConfigFile: string;
    serviceId?: string;
  }>;
};

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

const CONFIG_PATH = `${import.meta.dir}/railway.deploy.config.json`;

function readDeployFile(): Record<string, unknown> | null {
  try {
    const raw = Bun.file(CONFIG_PATH).textSync();
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function loadConfig(): DeployConfig {
  const raw = readDeployFile();
  if (!raw || !Array.isArray(raw.services)) {
    console.error(`Missing or invalid ${CONFIG_PATH}. Copy railway.deploy.config.example.json and edit.`);
    process.exit(1);
  }
  return raw as unknown as DeployConfig;
}

function railwayAuthHeaders(): Record<string, string> {
  const projectAccess = process.env.RAILWAY_PROJECT_ACCESS_TOKEN?.trim();
  if (projectAccess) {
    return { 'content-type': 'application/json', 'Project-Access-Token': projectAccess };
  }
  const bearer = process.env.RAILWAY_API_TOKEN?.trim();
  if (bearer) {
    return { 'content-type': 'application/json', authorization: `Bearer ${bearer}` };
  }
  return { 'content-type': 'application/json' };
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const headers = railwayAuthHeaders();
  if (!headers.authorization && !headers['Project-Access-Token']) {
    throw new Error('Missing RAILWAY_API_TOKEN or RAILWAY_PROJECT_ACCESS_TOKEN');
  }
  const res = await fetch(GQL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as GqlResp<T>;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join('; '));
  }
  if (body.data === undefined) {
    throw new Error('Empty GraphQL response');
  }
  return body.data;
}

function resolveServiceId(services: ServiceEdge[], matchName: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const m = matchName.trim().toLowerCase();
  const hit = services.find((e) => {
    const n = e.node.name.toLowerCase();
    return n === m || n.includes(m) || m.includes(n);
  });
  if (!hit) {
    const names = services.map((s) => s.node.name).join(', ');
    throw new Error(`No service matching "${matchName}". Known services: ${names || '(none)'}`);
  }
  return hit.node.id;
}

function pickEnvironment(
  edges: EnvEdge[],
  opts?: { name?: string; id?: string },
): { id: string; name: string } {
  if (!edges.length) throw new Error('Project has no environments');
  const id = opts?.id?.trim();
  if (id) {
    const byId = edges.find((e) => e.node.id === id);
    if (byId) return { id: byId.node.id, name: byId.node.name };
    return { id, name: '(id not in project list — verify in Railway)' };
  }
  const want = (opts?.name ?? 'production').toLowerCase();
  const byName = edges.find((e) => e.node.name.toLowerCase() === want);
  if (byName) return { id: byName.node.id, name: byName.node.name };
  return { id: edges[0]!.node.id, name: edges[0]!.node.name };
}

const Q_PROJECT = `
query ProjectDeploy($id: String!) {
  project(id: $id) {
    id
    name
    environments(first: 30) {
      edges { node { id name } }
    }
    services(first: 60) {
      edges { node { id name } }
    }
  }
}`;

const M_CONNECT = `
mutation Connect($id: String!, $input: ServiceConnectInput!) {
  serviceConnect(id: $id, input: $input) { id name }
}`;

const M_INSTANCE = `
mutation Instance($environmentId: String, $serviceId: String!, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(environmentId: $environmentId, serviceId: $serviceId, input: $input)
}`;

const M_AUTODEPLOY = `
mutation Auto($input: ServiceInstanceAutoDeployUpdateInput!) {
  serviceInstanceAutoDeployUpdate(input: $input) { enabled }
}`;

const M_DEPLOY = `
mutation Deploy($serviceId: String!, $environmentId: String!) {
  serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId, latestCommit: true)
}`;

async function main() {
  const auth = railwayAuthHeaders();
  if (!auth.authorization && !auth['Project-Access-Token']) {
    console.error(
      'Set RAILWAY_API_TOKEN (Bearer, from railway.com/account/tokens) or RAILWAY_PROJECT_ACCESS_TOKEN (project token). Do not put API keys in railway.deploy.config.json.',
    );
    process.exit(1);
  }

  const fileMeta = readDeployFile();
  const projectId =
    process.env.RAILWAY_PROJECT_ID?.trim() ||
    (typeof fileMeta?.projectId === 'string' ? fileMeta.projectId.trim() : '');
  if (!projectId) {
    console.error('Set RAILWAY_PROJECT_ID or add "projectId" to scripts/railway/railway.deploy.config.json.');
    process.exit(1);
  }

  const data = await gql<{
    project: {
      id: string;
      name: string;
      environments: { edges: EnvEdge[] };
      services: { edges: ServiceEdge[] };
    };
  }>(Q_PROJECT, { id: projectId });

  const proj = data.project;
  const services = proj.services.edges;
  const envIdFromEnv = process.env.RAILWAY_ENVIRONMENT_ID?.trim();
  const envIdFromFile = typeof fileMeta?.environmentId === 'string' ? fileMeta.environmentId.trim() : '';
  const envNameFromEnv = process.env.RAILWAY_ENVIRONMENT_NAME?.trim();
  const envNameFromFile = typeof fileMeta?.environmentName === 'string' ? fileMeta.environmentName : undefined;
  const env = pickEnvironment(proj.environments.edges, {
    id: envIdFromEnv || envIdFromFile || undefined,
    name: envNameFromEnv ?? envNameFromFile,
  });

  if (argFlag('--list')) {
    console.log(`Project: ${proj.name} (${proj.id})`);
    console.log(`Environment: ${env.name} (${env.id})\nServices:`);
    for (const e of services) {
      console.log(`  - ${e.node.name}\t${e.node.id}`);
    }
    return;
  }

  const cfg = loadConfig();
  const dry = argFlag('--dry-run');
  const doDeploy = argFlag('--deploy');

  const activeEnv = cfg.environmentId?.trim()
    ? pickEnvironment(proj.environments.edges, { id: cfg.environmentId.trim() })
    : env;

  console.log(`Project ${proj.name} | env ${activeEnv.name} | repo ${cfg.githubRepo}@${cfg.branch}`);
  if (dry) console.log('(dry-run: no mutations sent)\n');

  for (const row of cfg.services) {
    const sid = resolveServiceId(services, row.matchName, row.serviceId);
    const label = services.find((s) => s.node.id === sid)?.node.name ?? sid;
    console.log(`\n→ ${label} (${sid})`);

    if (!dry) {
      try {
        await gql(M_CONNECT, {
          id: sid,
          input: { repo: cfg.githubRepo, branch: cfg.branch },
        });
        console.log('  serviceConnect: ok');
      } catch (e) {
        const msg = (e as Error).message;
        if (/already|connected|duplicate/i.test(msg)) {
          console.log('  serviceConnect: skipped (' + msg.slice(0, 120) + '…)');
        } else {
          throw e;
        }
      }

      await gql(M_INSTANCE, {
        environmentId: activeEnv.id,
        serviceId: sid,
        input: {
          rootDirectory: row.rootDirectory,
          railwayConfigFile: row.railwayConfigFile,
        },
      });
      console.log('  serviceInstanceUpdate (rootDirectory + railwayConfigFile): ok');

      await gql(M_AUTODEPLOY, {
        input: {
          enabled: true,
          projectId: proj.id,
          environmentId: activeEnv.id,
          serviceId: sid,
        },
      });
      console.log('  serviceInstanceAutoDeployUpdate: ok');

      if (doDeploy) {
        await gql(M_DEPLOY, { serviceId: sid, environmentId: activeEnv.id });
        console.log('  serviceInstanceDeploy(latestCommit): ok');
      }
    } else {
      console.log('  would: serviceConnect + serviceInstanceUpdate + autodeploy' + (doDeploy ? ' + deploy' : ''));
    }
  }

  console.log('\nDone. Pushes to the configured branch should trigger builds (GitHub App must have repo access).');
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
