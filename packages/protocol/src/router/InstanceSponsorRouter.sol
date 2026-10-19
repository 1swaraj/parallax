// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

/// @notice Fixed implementation proxy; the router is initialized atomically during creation.
contract InstanceSponsorRouter {
    address private immutable implementation;

    constructor(address routerImplementation, bytes memory initialization) {
        require(routerImplementation.code.length > 0, "Missing implementation");
        implementation = routerImplementation;
        (bool ok, bytes memory reason) = routerImplementation.delegatecall(initialization);
        if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
    }

    fallback() external {
        address target = implementation;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
