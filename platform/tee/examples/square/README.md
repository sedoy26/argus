# Square — end-to-end HTTP demo

An example Trusted Applet that computes `x²` for any integer, wrapped in a tiny Bun HTTP shim on the host so you can call it with `curl`.

```
curl → Bun webserver on localhost:3000 → Trusted OS bridge on 127.0.0.1:4000 → Rust applet → back
```

(On real USB Armory MK II hardware the bridge is at `10.0.0.1:4000` over USB-CDC-ECM. The shim defaults to QEMU; set `DEVICE_HOST=10.0.0.1` to point it at hardware.)

The webserver in `server.ts` is not part of the trusted computing base — it runs on your laptop. It just translates HTTP into the device's newline-delimited JSON/TCP protocol (and, when hot-swapping, uploads a new applet ELF over the same link). Hackathon projects that want a real HTTP/REST interface to a trusted operation can copy this pattern.

## Files

| File        | Role                                                                |
|-------------|---------------------------------------------------------------------|
| `main.rs`   | The Rust applet. Runs in Secure World, handles `Square` RPC.        |
| `server.ts` | Bun HTTP shim on `127.0.0.1:3000`. Translates `GET /square?x=N` → `{"Method":"Square","Input":"N"}` on `127.0.0.1:4000`. |

## Use it

From the repo root (the root README covers Docker + `make qemu`; do that first):

```bash
# Swap the Square applet into src/main.rs, rebuild, upload.
cp examples/square/main.rs src/main.rs
make applet
bun run upload
# (no host-IP re-arm needed under QEMU — the bridge stays up across the swap)

# Run the HTTP shim.
bun run examples/square/server.ts

# Hit it.
curl 'http://localhost:3000/square?x=7'
# {"x":7,"result":49}
```

## How `server.ts` works

It's ~55 lines. The interesting part is `callApplet`, which spawns a fresh `nc` per request:

```ts
async function callApplet(method: string, input: string): Promise<string> {
  const req = JSON.stringify({ Method: method, Input: input }) + '\n';
  const proc = Bun.spawn(['nc', '-w', '3', DEVICE_HOST, String(DEVICE_PORT)], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  proc.stdin.write(req);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const reply = JSON.parse(stdout.split('\n')[0]);
  if (reply.Error) throw new Error(reply.Error);
  return reply.Output ?? '';
}
```

Bun's own TCP APIs (`Bun.connect`, `node:net` compat) hold process-scoped state that gets wedged after the bridge link cycles (the workaround was discovered on hardware where every hot-swap reboots the device, but the same pattern is fine for QEMU too). Fresh `nc` processes per request sidestep that entirely.

The HTTP part is a standard `Bun.serve` with a single `/square` route.

## Going further

- Add a new RPC method to the applet: edit the `match` block in `main.rs`, `make applet`, upload.
- Add a new HTTP route in `server.ts` that calls your new method via `callApplet('YourMethod', input)`.
- The bridge protocol is under-documented on purpose — see the other examples (`blinky/`, `crypto/`, `attestation/`) for methods driven over `nc` with no webserver at all.
