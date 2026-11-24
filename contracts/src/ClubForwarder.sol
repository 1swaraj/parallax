// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

/// @notice The two functions of Community Passport's grant registry a forwarder uses (its IGrantRegistry).
interface IGrantRegistry {
    function execute(address account, address target, bytes calldata data) external returns (bytes memory);

    function revoke(address account, address grantee) external;
}

/**
 * @notice A community's grantee in Community Passport's grant registry: the address members grant, in place of a
 * server key.
 *
 * The registry forwards a call only when its caller holds a grant on the member's Account, and a grant names one
 * caller. An instance relays from several keys, so the keys call through this contract and the registry sees one
 * caller. Its owner, the community, decides which keys may relay. When a developer hands a community over, the
 * ownership and the relayer list change, and no member has to grant again.
 *
 * It holds no funds and adds no power: it can only do what members granted it, through the registry. A revert in
 * the registry or the Account (an ended grant, a function outside the grant) comes back unchanged.
 */
contract ClubForwarder {
    IGrantRegistry public immutable registry;
    address public owner;
    /// @notice Set by `transferOwnership`, and the owner once it calls `acceptOwnership`.
    address public pendingOwner;
    mapping(address relayer => bool) public isRelayer;

    event RelayerSet(address indexed relayer, bool allowed);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error InvalidAddress();
    error NotOwner();
    error NotPendingOwner();
    error NotRelayer();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IGrantRegistry registry_, address owner_, address[] memory relayers) {
        if (address(registry_).code.length == 0 || owner_ == address(0)) revert InvalidAddress();
        registry = registry_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        for (uint256 i = 0; i < relayers.length; i++) {
            _setRelayer(relayers[i], true);
        }
    }

    /// @notice Has the member's `account` call `target` with `data`, within what the member granted this contract.
    function execute(address account, address target, bytes calldata data) external returns (bytes memory) {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        return registry.execute(account, target, data);
    }

    /// @notice Ends this community's grant on `account`, e.g. when the member asks the community to forget them.
    function revoke(address account) external onlyOwner {
        registry.revoke(account, address(this));
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        _setRelayer(relayer, allowed);
    }

    /// @notice Starts handing the forwarder to `newOwner`, who takes it with `acceptOwnership`. Two steps, so that a
    /// mistyped address can't take a community's relaying with it. The zero address cancels a pending handover.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function _setRelayer(address relayer, bool allowed) private {
        if (relayer == address(0)) revert InvalidAddress();
        isRelayer[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }
}
