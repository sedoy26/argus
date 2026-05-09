// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FakeSwapNet} from "../src/FakeSwapNet.sol";

contract DemoTest is Test {
    MockUSDC internal usdc;
    FakeSwapNet internal swap;

    address internal alice = address(0xA1);
    address internal attacker = address(0xEE);

    function setUp() public {
        usdc = new MockUSDC();
        swap = new FakeSwapNet();
        usdc.mint(alice, 50_000e6);
        vm.prank(alice);
        usdc.approve(address(swap), type(uint256).max);
    }

    function test_attackerCanDrainBeforeRevoke() public {
        // Attacker uses FakeSwapNet's vuln to drain via transferFrom.
        bytes memory drain = abi.encodeWithSelector(
            usdc.transferFrom.selector,
            alice,
            attacker,
            50_000e6
        );
        vm.prank(attacker);
        swap.execute(address(usdc), drain);
        assertEq(usdc.balanceOf(attacker), 50_000e6, "attack should succeed");
    }

    function test_guardianRevokeStopsAttacker() public {
        // Guardian revokes the approval before the attacker arrives.
        vm.prank(alice);
        usdc.approve(address(swap), 0);

        bytes memory drain = abi.encodeWithSelector(
            usdc.transferFrom.selector,
            alice,
            attacker,
            50_000e6
        );
        vm.prank(attacker);
        vm.expectRevert(bytes("external call failed"));
        swap.execute(address(usdc), drain);

        assertEq(usdc.balanceOf(attacker), 0, "attack must be blocked");
        assertEq(usdc.balanceOf(alice), 50_000e6, "victim must still hold funds");
    }
}
