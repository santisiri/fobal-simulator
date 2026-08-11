// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "../BaseFixture.sol";
import {FobalMatchEscrow} from "../../src/FobalMatchEscrow.sol";
import {FobalTypes} from "../../src/interfaces/IFobalPlayer.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice Minimal ERC-1271 signer: approves a fixed digest. Stands in for a
/// multisig/smart-account engine signer to prove SignatureChecker accepts
/// contract signers, so the engine/generator authority can be a Safe.
contract MockSmartSigner is IERC1271 {
    mapping(bytes32 => bool) public approved;

    function approve(bytes32 digest) external {
        approved[digest] = true;
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        return approved[hash] ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract Erc1271SignerTest is BaseFixture {
    MockSmartSigner internal smartSigner;

    function setUp() public override {
        super.setUp();
        smartSigner = new MockSmartSigner();
        vm.prank(admin);
        escrow.setSigner(address(smartSigner));
    }

    function test_contractSigner_settlesMatch() public {
        uint256[] memory a = mintSquadFor(alice, 1, 1);
        uint256[] memory b = mintSquadFor(bob, 2, 1);
        vm.prank(alice);
        bytes32 matchId = escrow.createMatch{value: 1 ether}(
            FobalMatchEscrow.Mode.PROGRESSION,
            address(0),
            1 ether,
            keccak256("r"),
            address(0),
            1 days,
            1 days,
            1,
            a
        );
        vm.prank(bob);
        escrow.joinMatch{value: 1 ether}(matchId, 2, b);

        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](0);
        FobalMatchEscrow.MatchResult memory result = FobalMatchEscrow.MatchResult({
            matchId: matchId,
            resultNonce: 1,
            teamA: 1,
            teamB: 2,
            scoreA: 3,
            scoreB: 0,
            replayHash: keccak256("r"),
            statsRoot: keccak256("s"),
            progressionHash: keccak256(abi.encode(progs)),
            deadline: block.timestamp + 1 hours
        });

        // no approval yet → rejected
        vm.expectRevert(FobalMatchEscrow.InvalidSignature.selector);
        escrow.settle(result, hex"00", progs);

        // multisig approves the digest → settlement accepted (empty sig is
        // fine; ERC-1271 verifies against contract state, not raw ECDSA)
        smartSigner.approve(escrow.resultDigest(result));
        escrow.settle(result, hex"00", progs);
        assertEq(escrow.withdrawable(treasury, address(0)), 2 ether);
    }
}
