// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "../BaseFixture.sol";
import {FobalPlayerGenerator} from "../../src/FobalPlayerGenerator.sol";
import {FobalTypes} from "../../src/interfaces/IFobalPlayer.sol";

contract GeneratorTest is BaseFixture {
    function test_mintSquad_eleven() public {
        uint256[] memory ids = mintSquadFor(alice, 7, 11);
        assertEq(ids.length, 11);
        assertEq(player.balanceOf(alice), 11);
        // unique dna and appearance across the squad
        for (uint256 i; i < ids.length; ++i) {
            for (uint256 j = i + 1; j < ids.length; ++j) {
                assertTrue(player.dnaOf(ids[i]) != player.dnaOf(ids[j]), "dna collision");
            }
        }
        assertEq(generator.nonces(alice), 1);
    }

    function test_replay_sameSignatureFails() public {
        FobalTypes.PlayerSeed[] memory seeds = makeSquad(2);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signSquad(alice, 0, 1, 0, deadline, seeds);
        generator.mintSquad(alice, 0, 1, deadline, seeds, sig);
        // nonce advanced -> identical payload no longer verifies
        vm.expectRevert(FobalPlayerGenerator.InvalidSignature.selector);
        generator.mintSquad(alice, 0, 1, deadline, seeds, sig);
    }

    function test_wrongSigner_fails() public {
        FobalTypes.PlayerSeed[] memory seeds = makeSquad(1);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _squadDigestMemory(alice, 0, 1, 0, deadline, seeds);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        vm.expectRevert(FobalPlayerGenerator.InvalidSignature.selector);
        generator.mintSquad(alice, 0, 1, deadline, seeds, abi.encodePacked(r, s, v));
    }

    function test_revokedSigner_failsAfterRotation() public {
        FobalTypes.PlayerSeed[] memory seeds = makeSquad(1);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signSquad(alice, 0, 1, 0, deadline, seeds);
        vm.prank(admin);
        generator.setSigner(makeAddr("newSigner"));
        vm.expectRevert(FobalPlayerGenerator.InvalidSignature.selector);
        generator.mintSquad(alice, 0, 1, deadline, seeds, sig);
    }

    function test_expiredDeadline_fails() public {
        FobalTypes.PlayerSeed[] memory seeds = makeSquad(1);
        uint256 deadline = block.timestamp + 10;
        bytes memory sig = signSquad(alice, 0, 1, 0, deadline, seeds);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(FobalPlayerGenerator.DeadlineExpired.selector, deadline));
        generator.mintSquad(alice, 0, 1, deadline, seeds, sig);
    }

    function test_tamperedSeeds_failSignature() public {
        FobalTypes.PlayerSeed[] memory seeds = makeSquad(2);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signSquad(alice, 0, 1, 0, deadline, seeds);
        seeds[1].skills = flatSkills(60); // any tampering breaks playersHash
        vm.expectRevert(FobalPlayerGenerator.InvalidSignature.selector);
        generator.mintSquad(alice, 0, 1, deadline, seeds, sig);
    }

    function test_powerBudget_blocksGodSquads() public {
        FobalTypes.PlayerSeed[] memory seeds = makeSquad(2);
        seeds[0].skills = flatSkills(100); // 1200 points
        seeds[1].skills = flatSkills(100); // total 2400 > 2*720
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signSquad(alice, 0, 1, 0, deadline, seeds);
        vm.expectRevert(abi.encodeWithSelector(FobalPlayerGenerator.PowerBudgetExceeded.selector, 2400, 1440));
        generator.mintSquad(alice, 0, 1, deadline, seeds, sig);
    }

    function test_squadSizeBounds() public {
        FobalTypes.PlayerSeed[] memory none = new FobalTypes.PlayerSeed[](0);
        uint256 deadline = block.timestamp + 1 hours;
        vm.expectRevert(abi.encodeWithSelector(FobalPlayerGenerator.SquadSizeInvalid.selector, 0));
        generator.mintSquad(alice, 0, 1, deadline, none, "");

        FobalTypes.PlayerSeed[] memory tooMany = makeSquad(24);
        vm.expectRevert(abi.encodeWithSelector(FobalPlayerGenerator.SquadSizeInvalid.selector, 24));
        generator.mintSquad(alice, 0, 1, deadline, tooMany, "");
    }

    function test_generatorCannotTouchExistingPlayers() public {
        uint256[] memory ids = mintSquadFor(alice, 0, 1);
        // the generator holds MINTER_ROLE only — progression/locking revert
        vm.startPrank(address(generator));
        vm.expectRevert();
        player.applyProgression(ids[0], defaultProgress(ids[0], 0).delta);
        vm.expectRevert();
        player.lock(ids[0]);
        vm.stopPrank();
    }

    function test_paused_blocksMinting() public {
        vm.prank(admin);
        generator.pause();
        FobalTypes.PlayerSeed[] memory seeds = makeSquad(1);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signSquad(alice, 0, 1, 0, deadline, seeds);
        vm.expectRevert();
        generator.mintSquad(alice, 0, 1, deadline, seeds, sig);
    }
}
