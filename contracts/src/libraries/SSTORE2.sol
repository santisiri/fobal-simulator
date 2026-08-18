// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Store bytes as contract CODE rather than in storage.
/// @dev The art atlas is written once and read on every `tokenURI` call, so
/// the cost that matters is the READ. Slicing a `bytes constant` inside a
/// Solidity loop costs ~23k gas; an EXTCODECOPY of the same window costs
/// ~500. Writing is a one-off deploy, and code is immutable by construction —
/// a blob address cannot be rewritten, only repointed, which is exactly the
/// property art data should have.
///
/// Layout: the deployed runtime is `00` (STOP) followed by the payload, so
/// the blob can never be called into and executed.
library SSTORE2 {
    error DeploymentFailed();
    error OutOfBounds();

    function write(bytes memory data) internal returns (address pointer) {
        // creation code: copy (STOP ++ data) into memory and return it
        //   0x61 <len+1> 80 60 0A 3D 39 3D F3 00 <data>
        bytes memory createCode = abi.encodePacked(
            hex"61", uint16(data.length + 1), hex"80600A3D393DF300", data
        );
        assembly {
            pointer := create(0, add(createCode, 0x20), mload(createCode))
        }
        if (pointer == address(0)) revert DeploymentFailed();
    }

    function read(address pointer) internal view returns (bytes memory) {
        uint256 size = pointer.code.length;
        if (size == 0) revert OutOfBounds();
        return _codeAt(pointer, 1, size);
    }

    /// @param start offset into the PAYLOAD (the STOP prefix is handled here)
    function readSlice(address pointer, uint256 start, uint256 length) internal view returns (bytes memory) {
        uint256 size = pointer.code.length;
        if (size == 0 || start + length + 1 > size) revert OutOfBounds();
        return _codeAt(pointer, start + 1, start + length + 1);
    }

    function payloadLength(address pointer) internal view returns (uint256) {
        uint256 size = pointer.code.length;
        return size == 0 ? 0 : size - 1;
    }

    function _codeAt(address pointer, uint256 start, uint256 end) private view returns (bytes memory out) {
        uint256 len = end - start;
        assembly {
            out := mload(0x40)
            mstore(0x40, add(out, and(add(add(len, 0x20), 0x1f), not(0x1f))))
            mstore(out, len)
            extcodecopy(pointer, add(out, 0x20), start, len)
        }
    }
}
