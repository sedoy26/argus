// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {ArgusRiskResolver} from "../src/ArgusRiskResolver.sol";

/// @notice Deploy the Argus risk resolver pointing at one or more
/// CCIP-Read gateway URLs.
///
/// Env vars:
///   PRIVATE_KEY   - deployer key (0x-hex)
///   ARGUS_OWNER   - resolver owner; defaults to msg.sender
///   ARGUS_URLS    - comma-separated gateway URL list
///                   (default: https://gateway.argus.example/lookup/{sender}/{data}.json)
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $SEPOLIA_RPC_URL \
///     --broadcast \
///     --verify
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address sender = vm.addr(pk);
        address owner = vm.envOr("ARGUS_OWNER", sender);
        string memory rawUrls = vm.envOr(
            "ARGUS_URLS",
            string(
                "https://gateway.argus.example/lookup/{sender}/{data}.json"
            )
        );
        string[] memory urls = _splitCsv(rawUrls);

        vm.startBroadcast(pk);
        ArgusRiskResolver resolver = new ArgusRiskResolver(urls, owner);
        vm.stopBroadcast();

        console2.log("ArgusRiskResolver deployed at", address(resolver));
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
