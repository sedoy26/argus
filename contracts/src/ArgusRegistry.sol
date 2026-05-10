// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title ArgusRegistry — on-chain agent whitelist for the Argus network.
///
/// Agents (scouts, guardians, watchers) must be approved by the registry
/// owner before their signals are trusted by the platform. This prevents
/// spam and Sybil attacks while keeping the network open to new contributors.
///
/// Roles:
///   SCOUT    — submits off-chain intelligence (social feeds, audit reports)
///   GUARDIAN — executes protective actions (revoke, withdraw) via KMS
///   WATCHER  — monitors on-chain events and Sourcify source code
///
/// Lifecycle:
///   1. Agent calls registerAgent() — status becomes PENDING
///   2. Owner calls approveAgent() — status becomes ACTIVE
///   3. Owner can revokeAgent()   — status becomes REVOKED
///   4. Owner/TEE updates reputation via updateReputation()
contract ArgusRegistry {
    // ── Types ────────────────────────────────────────────────────────────────

    enum Role { SCOUT, GUARDIAN, WATCHER }

    enum Status { PENDING, ACTIVE, REVOKED }

    struct Agent {
        address addr;
        Role    role;
        Status  status;
        string  ensName;     // e.g. scout.agents.argus-security.eth
        string  specialty;   // e.g. "social-feeds", "sourcify", "onchain"
        uint256 reputation;  // 0-100, updated by platform
        uint256 signalCount; // total signals accepted
        uint256 registeredAt;
        uint256 approvedAt;
    }

    // ── Storage ──────────────────────────────────────────────────────────────

    address public owner;
    address[] private _agentList;
    mapping(address => Agent) private _agents;
    mapping(address => bool)  private _registered;

    // ── Events ───────────────────────────────────────────────────────────────

    event AgentRegistered(address indexed agent, Role role, string ensName);
    event AgentApproved(address indexed agent, Role role, string ensName);
    event AgentRevoked(address indexed agent, string reason);
    event ReputationUpdated(address indexed agent, uint256 oldRep, uint256 newRep);
    event SignalCounted(address indexed agent, uint256 total);
    event OwnershipTransferred(address indexed prev, address indexed next);

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotOwner();
    error AlreadyRegistered();
    error NotRegistered();
    error AlreadyActive();
    error NotPending();
    error NotRevoked();
    error InvalidReputation();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _owner) {
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ── Registration (anyone can apply) ──────────────────────────────────────

    /// @notice Apply to join the Argus network as an agent.
    /// Starts in PENDING state — owner must call approveAgent() to activate.
    function registerAgent(
        Role   role,
        string calldata ensName,
        string calldata specialty
    ) external {
        if (_registered[msg.sender]) revert AlreadyRegistered();

        _registered[msg.sender] = true;
        _agentList.push(msg.sender);
        _agents[msg.sender] = Agent({
            addr:         msg.sender,
            role:         role,
            status:       Status.PENDING,
            ensName:      ensName,
            specialty:    specialty,
            reputation:   50, // default starting reputation
            signalCount:  0,
            registeredAt: block.timestamp,
            approvedAt:   0
        });

        emit AgentRegistered(msg.sender, role, ensName);
    }

    // ── Owner controls ────────────────────────────────────────────────────────

    /// @notice Approve a pending agent, activating their participation.
    function approveAgent(address agent) external onlyOwner {
        if (!_registered[agent]) revert NotRegistered();
        Agent storage a = _agents[agent];
        if (a.status != Status.PENDING) revert NotPending();
        a.status = Status.ACTIVE;
        a.approvedAt = block.timestamp;
        emit AgentApproved(agent, a.role, a.ensName);
    }

    /// @notice Directly register AND approve an agent in one call.
    /// Use for bootstrapping trusted agents (team-operated scouts, guardian).
    function registerAndApprove(
        address agent,
        Role    role,
        string  calldata ensName,
        string  calldata specialty,
        uint256 reputation
    ) external onlyOwner {
        if (_registered[agent]) revert AlreadyRegistered();
        if (reputation > 100) revert InvalidReputation();

        _registered[agent] = true;
        _agentList.push(agent);
        _agents[agent] = Agent({
            addr:         agent,
            role:         role,
            status:       Status.ACTIVE,
            ensName:      ensName,
            specialty:    specialty,
            reputation:   reputation,
            signalCount:  0,
            registeredAt: block.timestamp,
            approvedAt:   block.timestamp
        });

        emit AgentRegistered(agent, role, ensName);
        emit AgentApproved(agent, role, ensName);
    }

    /// @notice Revoke an agent (PENDING or ACTIVE → REVOKED).
    function revokeAgent(address agent, string calldata reason) external onlyOwner {
        if (!_registered[agent]) revert NotRegistered();
        _agents[agent].status = Status.REVOKED;
        emit AgentRevoked(agent, reason);
    }

    /// @notice Restore revoked agents to ACTIVE (demo reset / reinstatement). Owner-only batch.
    function restoreAgents(address[] calldata agentList) external onlyOwner {
        for (uint256 i; i < agentList.length; ++i) {
            address agent = agentList[i];
            if (!_registered[agent]) revert NotRegistered();
            Agent storage a = _agents[agent];
            if (a.status != Status.REVOKED) revert NotRevoked();
            a.status = Status.ACTIVE;
            a.approvedAt = block.timestamp;
            emit AgentApproved(agent, a.role, a.ensName);
        }
    }

    /// @notice Update an agent's reputation score (0-100).
    /// Called by the platform after TEE consensus validation.
    function updateReputation(address agent, uint256 newRep) external onlyOwner {
        if (!_registered[agent]) revert NotRegistered();
        if (newRep > 100) revert InvalidReputation();
        uint256 old = _agents[agent].reputation;
        _agents[agent].reputation = newRep;
        emit ReputationUpdated(agent, old, newRep);
    }

    /// @notice Increment signal count for an agent (called by platform).
    function recordSignal(address agent) external onlyOwner {
        if (!_registered[agent]) revert NotRegistered();
        _agents[agent].signalCount++;
        emit SignalCounted(agent, _agents[agent].signalCount);
    }

    /// @notice Transfer registry ownership.
    function transferOwnership(address next) external onlyOwner {
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function isApproved(address agent) external view returns (bool) {
        return _registered[agent] && _agents[agent].status == Status.ACTIVE;
    }

    function getAgent(address agent) external view returns (Agent memory) {
        if (!_registered[agent]) revert NotRegistered();
        return _agents[agent];
    }

    function agentCount() external view returns (uint256) {
        return _agentList.length;
    }

    function agentAt(uint256 index) external view returns (address) {
        return _agentList[index];
    }

    /// @notice Return all agents (use carefully — unbounded).
    function allAgents() external view returns (Agent[] memory) {
        Agent[] memory out = new Agent[](_agentList.length);
        for (uint256 i; i < _agentList.length; ++i) {
            out[i] = _agents[_agentList[i]];
        }
        return out;
    }

    /// @notice Return only ACTIVE agents.
    function activeAgents() external view returns (Agent[] memory) {
        uint256 count;
        for (uint256 i; i < _agentList.length; ++i) {
            if (_agents[_agentList[i]].status == Status.ACTIVE) count++;
        }
        Agent[] memory out = new Agent[](count);
        uint256 j;
        for (uint256 i; i < _agentList.length; ++i) {
            if (_agents[_agentList[i]].status == Status.ACTIVE) {
                out[j++] = _agents[_agentList[i]];
            }
        }
        return out;
    }
}
