// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {ArgusRiskResolver} from "../src/ArgusRiskResolver.sol";
import {ArgusRegistry} from "../src/ArgusRegistry.sol";
import {FakeSwapNet} from "../src/FakeSwapNet.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @notice Deploy all Argus demo contracts:
///   - ArgusRiskResolver  (ENS CCIP-Read wildcard resolver)
///   - ArgusRegistry      (agent whitelist — scouts, guardians, watchers)
///   - FakeSwapNet        (demo vulnerable contract, SWAT-001/002)
///   - MockUSDC           (demo ERC-20 token)
///
/// Env vars:
///   PRIVATE_KEY        - deployer key (0x-hex)
///   ARGUS_OWNER        - registry/resolver owner; defaults to msg.sender
///   ARGUS_URLS         - comma-separated gateway URL list
///   GUARDIAN_ADDRESS   - address of the guardian KMS wallet (optional)
///   SCOUT_ADDRESS      - address of the scout agent wallet (optional)
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $SEPOLIA_RPC_URL \
///     --broadcast
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address sender = vm.addr(pk);
        address owner = vm.envOr("ARGUS_OWNER", sender);
        string memory rawUrls = vm.envOr(
            "ARGUS_URLS",
            string("https://gateway.argus.example/lookup/{sender}/{data}.json")
        );
        string[] memory urls = _splitCsv(rawUrls);

        // Optional pre-registered agent addresses
        address guardianAddr = vm.envOr("GUARDIAN_ADDRESS", address(0));
        address scoutAddr    = vm.envOr("SCOUT_ADDRESS", address(0));

        vm.startBroadcast(pk);

        ArgusRiskResolver resolver = new ArgusRiskResolver(urls, owner);
        FakeSwapNet fakeSwapNet = new FakeSwapNet();
        MockUSDC mockUSDC = new MockUSDC();

        // Deploy registry and pre-approve the platform's own agents
        ArgusRegistry registry = new ArgusRegistry(owner);

        // Register the platform-operated scout (ENS: scout.agents.argus-security.eth)
        if (scoutAddr != address(0)) {
            registry.registerAndApprove(
                scoutAddr,
                ArgusRegistry.Role.SCOUT,
                "scout.agents.argus-security.eth",
                "social-feeds,apify,reddit",
                80
            );
        }

        // Register the platform-operated guardian (ENS: guardian.agents.argus-security.eth)
        if (guardianAddr != address(0)) {
            registry.registerAndApprove(
                guardianAddr,
                ArgusRegistry.Role.GUARDIAN,
                "guardian.agents.argus-security.eth",
                "revoke,withdraw,kms-signed",
                90
            );
        }

        // Always register the deployer as a WATCHER (Sourcify code analyzer)
        registry.registerAndApprove(
            sender,
            ArgusRegistry.Role.WATCHER,
            "watcher-sourcify.agents.argus-security.eth",
            "sourcify,onchain-events",
            85
        );

        vm.stopBroadcast();

        console2.log("ArgusRiskResolver deployed at", address(resolver));
        console2.log("ArgusRegistry     deployed at", address(registry));
        console2.log("FakeSwapNet       deployed at", address(fakeSwapNet));
        console2.log("MockUSDC          deployed at", address(mockUSDC));
        console2.log("owner", owner);
        for (uint256 i; i < urls.length; ++i) {
            console2.log("url", urls[i]);
        }
    }

    function _splitCsv(string memory s) internal pure returns (string[] memory) {
        bytes memory raw = bytes(s);
        // Count parts.
        uint256 count = 1;
        for (uint256 i; i < raw.length; ++i) {
            if (raw[i] == ",") count++;
        }
        string[] memory out = new string[](count);
        uint256 start = 0;
        uint256 idx = 0;
        for (uint256 i = 0; i <= raw.length; ++i) {
            if (i == raw.length || raw[i] == ",") {
                bytes memory part = new bytes(i - start);
                for (uint256 j = 0; j < part.length; ++j) {
                    part[j] = raw[start + j];
                }
                out[idx++] = string(part);
                start = i + 1;
            }
        }
        return out;
    }
}
