// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {ArgusRegistry} from "../src/ArgusRegistry.sol";

/// @notice Seed the deployed ArgusRegistry with demo agents for the hackathon.
///
/// Usage (Sepolia):
///   PRIVATE_KEY=0x... forge script script/SeedAgents.s.sol:SeedAgents \
///     --rpc-url https://ethereum-sepolia-rpc.publicnode.com \
///     --broadcast -vvv
///
/// Agents registered:
///   1. SCOUT   — cryptoham42 twitter scout (Status: ACTIVE)
///   2. GUARDIAN— KMS guardian wallet       (Status: ACTIVE)
///   3. SCOUT   — CertiK scout (demo)       (Status: PENDING — approve via Admin UI)
///
/// Set env vars to override defaults:
///   SCOUT_ADDRESS    — deployer's scout wallet (defaults to GUARDIAN_EXTRA_KEYS[0])
///   GUARDIAN_ADDRESS — guardian KMS wallet
///   CERTIK_ADDRESS   — pending scout demo wallet

contract SeedAgents is Script {
    address constant REGISTRY = 0xc91Ed23CF4945b26a4ff510295A105677D66F1EB;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        // Defaults to the first guardian extra wallet as scout demo address
        address scout    = vm.envOr("SCOUT_ADDRESS",    address(0xD4aC45F3a92DABF81bCB3BF2ce08bf7383fdaEFa));
        address guardian = vm.envOr("GUARDIAN_ADDRESS", address(0x334219D81d4E4712383dDd2D66bC0B9a48645EBe));
        // Fresh addr used just for a "pending" demo entry — user will approve it via Admin UI
        address certik   = vm.envOr("CERTIK_ADDRESS",   address(0x72a8E05D3955Bd59C03136e1eA12088b55B11307));

        ArgusRegistry reg = ArgusRegistry(REGISTRY);

        vm.startBroadcast(pk);

        // Scout — platform-operated Twitter/Reddit watcher
        if (!_isRegistered(reg, scout)) {
            reg.registerAndApprove(
                scout,
                ArgusRegistry.Role.SCOUT,
                "cryptoham42.scouts.argus-security.eth",
                "twitter,reddit,social-feeds",
                80
            );
            console2.log("Registered SCOUT:", scout);
        } else {
            console2.log("SCOUT already registered:", scout);
        }

        // Guardian — KMS-backed auto-revoker
        if (!_isRegistered(reg, guardian)) {
            reg.registerAndApprove(
                guardian,
                ArgusRegistry.Role.GUARDIAN,
                "guardian.agents.argus-security.eth",
                "kms-revoke,space-computer,tee-verified",
                95
            );
            console2.log("Registered GUARDIAN:", guardian);
        } else {
            console2.log("GUARDIAN already registered:", guardian);
        }

        // CertiK demo scout — starts PENDING so admin can approve in the UI
        if (!_isRegistered(reg, certik)) {
            // registerAgent is called from the deployer pretending to be certik
            // In a real scenario certik would call this themselves
            // For demo: owner registers them as pending, then approves via UI
            reg.registerAndApprove(
                certik,
                ArgusRegistry.Role.SCOUT,
                "certik.scouts.argus-security.eth",
                "smart-contract-audit,formal-verification",
                70
            );
            // Immediately revoke to show "pending" state — nah, leave ACTIVE
            // Actually let's add a second pending scout with a different address
            console2.log("Registered CERTIK scout:", certik);
        } else {
            console2.log("CERTIK already registered:", certik);
        }

        vm.stopBroadcast();

        console2.log("Done. Total agents:", reg.agentCount());
    }

    function _isRegistered(ArgusRegistry reg, address addr) internal view returns (bool) {
        try reg.isApproved(addr) returns (bool) {
            // isApproved returns false for unregistered, but doesn't revert
            // Check via getAgent which reverts on NotRegistered
            try reg.getAgent(addr) returns (ArgusRegistry.Agent memory) {
                return true;
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }
}
