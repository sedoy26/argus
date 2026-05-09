// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IExtendedResolver — ENSIP-10 wildcard-resolver interface.
/// @dev   `interfaceId == 0x9061b923`.
interface IExtendedResolver {
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory);
}

/// @title IERC165
interface IERC165 {
    function supportsInterface(bytes4 interfaceID)
        external
        view
        returns (bool);
}

/// @title ArgusRiskResolver — ENS wildcard resolver for Argus risk scores.
///
/// Owns no records. Every `resolve(name, data)` reverts with
/// `OffchainLookup` (EIP-3668), instructing the caller to fetch the
/// answer from the off-chain Argus gateway. The gateway pulls the
/// contract address out of the leading wildcard label
/// (`<addr>.<rest>.<root>`), reads the Argus consensus envelope, and
/// returns the ABI-encoded record value. We pass that back unchanged
/// — there is no on-chain signature verification because the trust
/// anchor is the gateway URL itself plus the TEE attestation tag the
/// gateway includes inside the envelope.
///
/// Wire it up by setting this contract as the resolver for any ENS
/// name you control, e.g. `risks.argus.eth`. ENSIP-10 wildcard
/// resolution then routes every `<addr>.risks.argus.eth` query here.
contract ArgusRiskResolver is IExtendedResolver, IERC165 {
    /// EIP-3668 OffchainLookup. Clients (CCIP-Read aware libraries:
    /// ethers, viem, ENS resolvers) recognise this revert and forward
    /// `callData` to one of `urls` to obtain the answer.
    error OffchainLookup(
        address sender,
        string[] urls,
        bytes callData,
        bytes4 callbackFunction,
        bytes extraData
    );

    /// Only the owner may rotate the gateway URL list. Setting to the
    /// zero address renounces ownership permanently.
    address public owner;

    /// Ordered list of gateway URLs the client should try. Each URL
    /// supports the EIP-3668 `{sender}` and `{data}` substitutions; if
    /// neither placeholder is present clients POST `{sender, data}` JSON.
    string[] public urls;

    event UrlsUpdated(string[] urls);
    event OwnershipTransferred(address indexed previous, address indexed next);

    constructor(string[] memory _urls, address _owner) {
        require(_owner != address(0), "owner=0");
        owner = _owner;
        urls = _urls;
        emit UrlsUpdated(_urls);
        emit OwnershipTransferred(address(0), _owner);
    }

    // ---------- IExtendedResolver -------------------------------------

    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory)
    {
        bytes memory callData = abi.encode(name, data);
        revert OffchainLookup(
            address(this),
            urls,
            callData,
            this.resolveCallback.selector,
            callData
        );
    }

    /// CCIP-Read callback. Pass the gateway response straight through;
    /// the gateway already returned the value in the format the
    /// original `data` selector expects (string for `text(...)`,
    /// address for `addr(...)`, etc.).
    function resolveCallback(
        bytes calldata response,
        bytes calldata /* extraData */
    ) external pure returns (bytes memory) {
        return response;
    }

    // ---------- Ownership ---------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function setUrls(string[] calldata _urls) external onlyOwner {
        delete urls;
        for (uint256 i; i < _urls.length; ++i) {
            urls.push(_urls[i]);
        }
        emit UrlsUpdated(_urls);
    }

    function transferOwnership(address next) external onlyOwner {
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    // ---------- IERC165 -----------------------------------------------

    function supportsInterface(bytes4 interfaceID)
        external
        pure
        returns (bool)
    {
        return interfaceID == type(IExtendedResolver).interfaceId
            || interfaceID == type(IERC165).interfaceId;
    }

    // ---------- View helpers ------------------------------------------

    function urlList() external view returns (string[] memory) {
        return urls;
    }
}
