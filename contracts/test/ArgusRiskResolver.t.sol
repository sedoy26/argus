// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ArgusRiskResolver, IExtendedResolver, IERC165} from "../src/ArgusRiskResolver.sol";

contract ArgusRiskResolverTest is Test {
    ArgusRiskResolver internal resolver;
    address internal owner = address(0xA1);

    string[] internal urls;

    function setUp() public {
        urls = new string[](1);
        urls[0] = "https://gateway.example.com/lookup/{sender}/{data}.json";
        resolver = new ArgusRiskResolver(urls, owner);
    }

    function test_supportsInterface_extendedResolver() public view {
        assertTrue(
            resolver.supportsInterface(type(IExtendedResolver).interfaceId),
            "missing IExtendedResolver"
        );
        assertTrue(
            resolver.supportsInterface(type(IERC165).interfaceId),
            "missing IERC165"
        );
        assertFalse(
            resolver.supportsInterface(0xdeadbeef),
            "claimed unrelated interface"
        );
    }

    function test_resolve_revertsWithOffchainLookup() public {
        bytes memory name = _dnsName("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.risks.argus.eth");
        // text(node, "score") — selector 0x59d1d43c
        bytes memory data = abi.encodeWithSelector(
            bytes4(0x59d1d43c),
            keccak256("placeholder-node"),
            "score"
        );

        bytes memory expectedCallData = abi.encode(name, data);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArgusRiskResolver.OffchainLookup.selector,
                address(resolver),
                urls,
                expectedCallData,
                ArgusRiskResolver.resolveCallback.selector,
                expectedCallData
            )
        );
        IExtendedResolver(address(resolver)).resolve(name, data);
    }

    function test_resolveCallback_passesResponseThrough() public view {
        bytes memory response = abi.encode(string("CRITICAL"));
        bytes memory out = resolver.resolveCallback(response, hex"");
        assertEq(out, response);
    }

    function test_setUrls_onlyOwner() public {
        string[] memory next = new string[](1);
        next[0] = "https://argus.eth.limo/lookup/{sender}/{data}.json";

        // wrong sender reverts
        vm.expectRevert(bytes("not owner"));
        resolver.setUrls(next);

        vm.prank(owner);
        resolver.setUrls(next);
        assertEq(resolver.urlList()[0], next[0]);
    }

    function test_transferOwnership() public {
        vm.prank(owner);
        resolver.transferOwnership(address(0xB2));
        assertEq(resolver.owner(), address(0xB2));

        // old owner can no longer set urls
        vm.expectRevert(bytes("not owner"));
        vm.prank(owner);
        string[] memory next = new string[](0);
        resolver.setUrls(next);
    }

    // ----- helpers -----

    /// Encodes a dotted ENS name into RFC-1035 DNS wire format.
    function _dnsName(string memory s) internal pure returns (bytes memory) {
        bytes memory raw = bytes(s);
        bytes memory out = new bytes(raw.length + 2);
        uint256 outLen = 0;
        uint256 labelStart = 0;

        for (uint256 i = 0; i <= raw.length; ++i) {
            if (i == raw.length || raw[i] == ".") {
                uint256 labelLen = i - labelStart;
                require(labelLen <= 255, "label too long");
                out[outLen++] = bytes1(uint8(labelLen));
                for (uint256 j = 0; j < labelLen; ++j) {
                    out[outLen++] = raw[labelStart + j];
                }
                labelStart = i + 1;
            }
        }
        out[outLen++] = 0x00;

        // Trim the buffer to the actual length.
        bytes memory trimmed = new bytes(outLen);
        for (uint256 k = 0; k < outLen; ++k) trimmed[k] = out[k];
        return trimmed;
    }
}
