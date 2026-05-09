// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title FakeSwapNet — the demo's vulnerable target.
///
/// Three roles in the Argus demo:
///   1. **Approval recipient** — users `approve(FakeSwapNet, ...)` on
///      tokens like MockUSDC, intending to swap. The guardian's job
///      is to revoke those approvals when Argus flags this address.
///   2. **SWAT-001 surface** — `execute(target, data)` makes an
///      unguarded arbitrary external call, which is exactly the
///      pattern Sourcify watchers detect. An attacker who finds
///      active approvals can call `execute(token, transferFrom(
///      victim, attacker, amount))` and drain the victim.
///   3. **SWAT-002 surface** — emits `OwnershipTransferred` so the
///      on-chain watcher can flag a transfer of admin to a fresh
///      EOA. Note that `execute()` is *not* owner-gated; the
///      ownership scope is intentionally narrow (set urls / pause /
///      etc., not enforced here) so the SWAT-001 vuln remains live
///      regardless of who owns the contract.
contract FakeSwapNet {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// SWAT-001 — arbitrary-call. No access control. No purpose other
    /// than to demonstrate the pattern that source-code watchers
    /// flag.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "external call failed");
        return ret;
    }

    /// Admin-rotation hook. Emitting OwnershipTransferred is what the
    /// on-chain watcher subscribes to.
    function transferOwnership(address next) external {
        require(msg.sender == owner, "not owner");
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    /// Marker so deployers can `cast call` this and visually confirm
    /// they're talking to the right contract.
    function isFakeSwapNet() external pure returns (bool) {
        return true;
    }
}
