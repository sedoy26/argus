// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {ArgusRegistry} from "../src/ArgusRegistry.sol";

/// @notice Deploy **only** ArgusRegistry (keeps FakeSwapNet / MockUSDC / resolver addresses unchanged).
///
/// Env:
///   PRIVATE_KEY   — deployer (must pay gas)
///   ARGUS_OWNER   — registry owner (defaults to deployer address)
///
/// Usage:
///   forge script script/DeployRegistry.s.sol:DeployRegistry \
///     --rpc-url $SEPOLIA_RPC_URL --broadcast -vvv
contract DeployRegistry is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("ARGUS_OWNER", deployer);

        vm.startBroadcast(pk);
        ArgusRegistry registry = new ArgusRegistry(owner);
        vm.stopBroadcast();

        console2.log("ArgusRegistry deployed at", address(registry));
        console2.log("owner", owner);
    }
}
