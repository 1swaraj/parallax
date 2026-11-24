// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

import {ClubForwarder, IGrantRegistry} from "../src/ClubForwarder.sol";

// Foundry's cheatcodes, declared here so the tests need no library.
interface Vm {
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// @dev A Lens Account as the registry sees it: one manager that can have it call anything.
contract MockAccount {
    address public immutable manager;

    constructor(address manager_) {
        manager = manager_;
    }

    function executeTransaction(address target, uint256, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == manager, "MockAccount: not the manager");
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }
}

/// @dev The grant registry's rules that matter here: a grant names its caller, and the grantee can end its own.
contract MockGrantRegistry is IGrantRegistry {
    error GrantNotActive();
    error NotOwnerOrGrantee();

    mapping(address account => mapping(address grantee => bool)) public granted;

    function grant(address account, address grantee) external {
        granted[account][grantee] = true;
    }

    function execute(address account, address target, bytes calldata data) external returns (bytes memory) {
        if (!granted[account][msg.sender]) revert GrantNotActive();
        return MockAccount(account).executeTransaction(target, 0, data);
    }

    function revoke(address account, address grantee) external {
        if (msg.sender != grantee) revert NotOwnerOrGrantee();
        granted[account][grantee] = false;
    }
}

contract MockFeed {
    address public lastCaller;

    function post(uint256 number) external returns (uint256) {
        lastCaller = msg.sender;
        return number + 1;
    }
}

contract ClubForwarderTest {
    address constant OWNER = address(0xA11CE);
    address constant RELAYER = address(0xBEEF);
    address constant OTHER_RELAYER = address(0xCAFE);
    address constant STRANGER = address(0xBAD);

    MockGrantRegistry registry;
    MockAccount account;
    MockFeed feed;
    ClubForwarder forwarder;

    function setUp() public {
        registry = new MockGrantRegistry();
        account = new MockAccount(address(registry));
        feed = new MockFeed();
        address[] memory relayers = new address[](1);
        relayers[0] = RELAYER;
        forwarder = new ClubForwarder(registry, OWNER, relayers);
        registry.grant(address(account), address(forwarder));
    }

    function _execute(address relayer) internal returns (bytes memory) {
        vm.prank(relayer);
        return forwarder.execute(address(account), address(feed), abi.encodeCall(MockFeed.post, (41)));
    }

    function _post(address relayer) internal returns (uint256) {
        return abi.decode(_execute(relayer), (uint256));
    }

    function test_relayerActsAsTheMember() public {
        require(_post(RELAYER) == 42, "the call's result comes back");
        require(feed.lastCaller() == address(account), "the feed sees the member's Account");
    }

    function test_onlyRelayersCanExecute() public {
        vm.expectRevert(ClubForwarder.NotRelayer.selector);
        _execute(STRANGER);
    }

    function test_registryRevertComesBackUnchanged() public {
        MockAccount ungranted = new MockAccount(address(registry));
        vm.prank(RELAYER);
        vm.expectRevert(MockGrantRegistry.GrantNotActive.selector);
        forwarder.execute(address(ungranted), address(feed), abi.encodeCall(MockFeed.post, (1)));
    }

    function test_ownerManagesRelayers() public {
        vm.prank(STRANGER);
        vm.expectRevert(ClubForwarder.NotOwner.selector);
        forwarder.setRelayer(OTHER_RELAYER, true);

        vm.prank(OWNER);
        forwarder.setRelayer(OTHER_RELAYER, true);
        require(_post(OTHER_RELAYER) == 42, "an added relayer can act");

        vm.prank(OWNER);
        forwarder.setRelayer(RELAYER, false);
        vm.expectRevert(ClubForwarder.NotRelayer.selector);
        _execute(RELAYER);
    }

    function test_ownerEndsTheCommunitysGrant() public {
        vm.prank(STRANGER);
        vm.expectRevert(ClubForwarder.NotOwner.selector);
        forwarder.revoke(address(account));

        vm.prank(OWNER);
        forwarder.revoke(address(account));
        require(!registry.granted(address(account), address(forwarder)), "the grant is gone");
        vm.expectRevert(MockGrantRegistry.GrantNotActive.selector);
        _execute(RELAYER);
    }

    function test_handoverKeepsMembersGrants() public {
        address community = address(0xC0FFEE);
        vm.prank(OWNER);
        forwarder.transferOwnership(community);
        require(forwarder.owner() == OWNER, "nothing moves until it is accepted");

        vm.prank(STRANGER);
        vm.expectRevert(ClubForwarder.NotPendingOwner.selector);
        forwarder.acceptOwnership();

        vm.prank(community);
        forwarder.acceptOwnership();
        require(forwarder.owner() == community && forwarder.pendingOwner() == address(0), "handed over");

        // The developer's key goes, the community's comes, and the member never signs anything.
        vm.prank(OWNER);
        vm.expectRevert(ClubForwarder.NotOwner.selector);
        forwarder.setRelayer(OWNER, true);
        vm.prank(community);
        forwarder.setRelayer(RELAYER, false);
        vm.prank(community);
        forwarder.setRelayer(OTHER_RELAYER, true);
        require(_post(OTHER_RELAYER) == 42, "the member's grant still works");
    }

    function test_constructorRefusesBadSettings() public {
        address[] memory none = new address[](0);
        vm.expectRevert(ClubForwarder.InvalidAddress.selector);
        new ClubForwarder(IGrantRegistry(address(0x1234)), OWNER, none);

        vm.expectRevert(ClubForwarder.InvalidAddress.selector);
        new ClubForwarder(registry, address(0), none);

        address[] memory zero = new address[](1);
        vm.expectRevert(ClubForwarder.InvalidAddress.selector);
        new ClubForwarder(registry, OWNER, zero);
    }
}
