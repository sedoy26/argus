// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title FakeSwapNet — the demo's vulnerable target.
///
/// Two roles in the Argus demo:
///   1. **Approval recipient** — users `approve(FakeSwapNet, ...)` on
///      tokens like MockUSDC, intending to swap. The guardian's job
///      is to revoke those approvals when Argus flags this address.
///   2. **Vulnerability source** — `execute(target, data)` makes an
///      unguarded arbitrary external call, which is exactly the
///      SWAT-001 pattern Sourcify watchers detect. An attacker who
///      finds active approvals can call `execute(token,
///      transferFrom(victim, attacker, amount))` and drain the
///      victim. With Argus + Guardian wired up, the approval has
///      already been revoked by the time the attacker arrives.
contract FakeSwapNet {
    /// SWAT-001 — arbitrary-call. No access control. No purpose other
    /// than to demonstrate the pattern that source-code watchers
    /// flag.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "external call failed");
        return ret;
    }

    /// Marker so deployers can `cast call` this and visually confirm
    /// they're talking to the right contract.
    function isFakeSwapNet() external pure returns (bool) {
        return true;
    }
}
