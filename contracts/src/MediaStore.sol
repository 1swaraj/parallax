// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

/**
 * Media (post images) kept in the chain's history instead of its state: `put` only emits the bytes it's given, so a
 * byte costs its calldata and log gas, not a storage write. Indexers read the chunks back from the logs.
 *
 * Media are addressed by their author and id: the author is whoever calls `put` (a Lens Account, through
 * Account.executeTransaction or SponsorRouter.execute), so no one can add chunks to another author's media. The id is
 * the SHA-256 of the whole file, which readers check once they put the chunks back together.
 */
contract MediaStore {
    event MediaChunk(address indexed author, bytes32 indexed id, uint256 offset, bytes data);

    function put(bytes32 id, uint256 offset, bytes calldata data) external {
        emit MediaChunk(msg.sender, id, offset, data);
    }
}
