// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "../BaseFixture.sol";
import {FobalArtLibrary} from "../../src/FobalArtLibrary.sol";
import {FobalFaceComposer} from "../../src/art/FobalFaceComposer.sol";
import {FobalKitComposer} from "../../src/art/FobalKitComposer.sol";
import {FobalSquadRegistry, ITeamsRead, IOwnerOf} from "../../src/art/FobalSquadRegistry.sol";
import {FobalKitRegistry} from "../../src/art/FobalKitRegistry.sol";
import {FobalRendererV2_1, IPlayerReader2} from "../../src/art/FobalRendererV2_1.sol";
import {FobalTraitEngine as TE} from "../../src/art/FobalTraitEngine.sol";
import {IFobalRenderer} from "../../src/interfaces/IFobalRenderer.sol";
import {FobalTypes} from "../../src/interfaces/IFobalPlayer.sol";

/// P4: the jersey follows the club, the face never moves.
contract TeamKitsTest is BaseFixture {
    FobalArtLibrary internal art;
    FobalSquadRegistry internal squads;
    FobalKitRegistry internal wardrobe;
    FobalRendererV2_1 internal r2;

    uint256[] internal ids;
    uint64 internal teamA;
    uint64 internal teamB;

    string[8] internal CLASSES = ["HEADS", "EYES", "BROWS", "NOSES", "MOUTHS", "BEARDS", "HAIR", "HEADWEAR"];

    function setUp() public override {
        super.setUp();
        ids = mintSquadFor(alice, 1, 11);

        art = new FobalArtLibrary(admin);
        vm.startPrank(admin);
        for (uint256 i; i < CLASSES.length; ++i) {
            string memory h = vm.readFile(
                string.concat(vm.projectRoot(), "/../packages/art/gen/blobs/", CLASSES[i], ".hex")
            );
            art.setClass(bytes32(bytes(CLASSES[i])), vm.parseBytes(vm.replace(h, "\n", "")));
        }
        vm.stopPrank();

        squads = new FobalSquadRegistry(IOwnerOf(address(player)), ITeamsRead(address(teams)));
        wardrobe = new FobalKitRegistry(ITeamsRead(address(teams)));
        r2 = new FobalRendererV2_1(
            IPlayerReader2(address(player)),
            new FobalFaceComposer(art),
            new FobalKitComposer(),
            squads,
            wardrobe
        );

        vm.prank(alice);
        teamA = teams.createTeam("ALICE FC", keccak256("alice-dna"));
        vm.prank(bob);
        teamB = teams.createTeam("BOB UNITED", keccak256("bob-dna"));
    }

    function _face(uint256 tokenId) internal view returns (bytes32) {
        FobalTypes.PlayerView memory v = player.playerView(tokenId);
        return r2.faceHash(v.dna, v.appearance);
    }

    function _image(uint256 tokenId) internal view returns (bytes32) {
        FobalTypes.PlayerView memory v = player.playerView(tokenId);
        return keccak256(bytes(r2.imageOf(tokenId, v.dna, v.appearance, v.core.position)));
    }

    // ------------------------------------------------- THE HEADLINE TEST

    /// A player moves club: the jersey changes, the face does not.
    function test_transferBetweenClubs_changesKit_neverFace() public {
        uint256 id = ids[3];
        bytes32 faceBefore = _face(id);

        vm.startPrank(alice);
        wardrobe.setKit(teamA, wardrobe.HOME(), 0x2f6fd0, 0xf2f4f8, 0xf2f4f8, 2);
        squads.join(id, teamA);
        vm.stopPrank();
        bytes32 atA = _image(id);

        vm.startPrank(bob);
        wardrobe.setKit(teamB, wardrobe.HOME(), 0xc8322b, 0x1b1b1f, 0xf2f4f8, 1);
        vm.stopPrank();
        // the NFT owner moves their player; only the owner can do this
        vm.prank(alice);
        squads.join(id, teamB);
        bytes32 atB = _image(id);

        assertTrue(atA != atB, "a new club must mean a new jersey");
        assertEq(_face(id), faceBefore, "the face must not move with the club");
        assertEq(squads.teamOf(id), teamB);
    }

    /// Selling a player does NOT silently repaint them: squad membership is
    /// explicit state, so the art only changes when someone transacts.
    function test_saleDoesNotImplicitlyChangeTheKit() public {
        uint256 id = ids[4];
        vm.startPrank(alice);
        wardrobe.setKit(teamA, wardrobe.HOME(), 0x2f6fd0, 0xf2f4f8, 0xf2f4f8, 2);
        squads.join(id, teamA);
        player.transferFrom(alice, bob, id);
        vm.stopPrank();

        assertEq(player.ownerOf(id), bob, "ownership moved");
        assertEq(squads.teamOf(id), teamA, "club membership did not");
        assertEq(_face(id), _face(id), "face is a pure function of identity");
    }

    function test_kitChangeRepaintsWithoutTouchingIdentity() public {
        uint256 id = ids[5];
        vm.startPrank(alice);
        wardrobe.setKit(teamA, wardrobe.HOME(), 0x2f6fd0, 0xf2f4f8, 0xf2f4f8, 2);
        squads.join(id, teamA);
        bytes32 before = _image(id);
        bytes32 faceBefore = _face(id);
        wardrobe.setKit(teamA, wardrobe.HOME(), 0xe0b024, 0x1b1b1f, 0x1b1b1f, 3);
        vm.stopPrank();
        assertTrue(_image(id) != before, "a new club kit must repaint the squad");
        assertEq(_face(id), faceBefore, "and must not touch anyone's face");
    }

    function test_awayKitSwitchesTheWholeSquadAtOnce() public {
        vm.startPrank(alice);
        wardrobe.setKit(teamA, wardrobe.HOME(), 0x2f6fd0, 0xf2f4f8, 0xf2f4f8, 2);
        wardrobe.setKit(teamA, wardrobe.AWAY(), 0x1b1b1f, 0xe0b024, 0xe0b024, 4);
        uint256[] memory squad = new uint256[](3);
        for (uint256 i; i < 3; ++i) squad[i] = ids[i];
        squads.joinBatch(squad, teamA);
        bytes32 homeLook = _image(ids[1]);
        wardrobe.setActiveKit(teamA, wardrobe.AWAY());
        vm.stopPrank();
        assertTrue(_image(ids[1]) != homeLook, "switching kit changes what the squad wears");
    }

    /// Goalkeepers wear the keeper slot no matter what the club has selected.
    function test_keeperWearsTheKeeperKit() public {
        vm.startPrank(alice);
        wardrobe.setKit(teamA, wardrobe.HOME(), 0x2f6fd0, 0xf2f4f8, 0xf2f4f8, 2);
        wardrobe.setKit(teamA, wardrobe.KEEPER(), 0x2f8f4e, 0x1b1b1f, 0x1b1b1f, 0);
        squads.join(ids[0], teamA); // minted GK-first
        vm.stopPrank();
        FobalTypes.PlayerView memory gk = player.playerView(ids[0]);
        assertEq(gk.core.position, 0, "fixture assumption: token 0 is the keeper");
        FobalKitRegistry.Kit memory k = wardrobe.kitFor(teamA, 0);
        assertEq(k.primary, uint24(0x2f8f4e), "the keeper wears the keeper kit");
    }

    // ------------------------------------------------------- degradation

    function test_unassignedPlayerWearsAFreeAgentKit() public view {
        FobalTypes.PlayerView memory v = player.playerView(ids[2]);
        (, uint64 teamId, bool clubKit) = r2.kitOf(ids[2], TE.seedOf(v.dna, v.appearance), v.core.position);
        assertEq(teamId, 0);
        assertFalse(clubKit);
        assertGt(bytes(r2.imageOf(ids[2], v.dna, v.appearance, v.core.position)).length, 200);
    }

    /// A club that has configured nothing still looks like a club.
    function test_unconfiguredClubGetsADeterministicKit() public {
        vm.prank(alice);
        squads.join(ids[6], teamA);
        FobalKitRegistry.Kit memory k = wardrobe.kitFor(teamA, 2);
        assertFalse(k.set, "not configured");
        FobalKitRegistry.Kit memory again = wardrobe.kitFor(teamA, 2);
        assertEq(k.primary, again.primary, "but deterministic");
        assertLt(k.pattern, 7);
    }

    /// The render path must never call anything that reverts on unknown ids —
    /// FobalTeamRegistry.ownerOfTeam does exactly that, which is why the
    /// registries read the auto-getter instead.
    function test_unknownTeamNeverBricksRendering() public view {
        FobalKitRegistry.Kit memory k = wardrobe.kitFor(999_999, 2);
        assertLt(k.pattern, 7, "an unknown club still resolves to a drawable kit");
    }

    function test_rendererSurvivesMissingRegistries() public {
        FobalRendererV2_1 bare = new FobalRendererV2_1(
            IPlayerReader2(address(player)),
            new FobalFaceComposer(art),
            new FobalKitComposer(),
            FobalSquadRegistry(address(0)),
            FobalKitRegistry(address(0))
        );
        FobalTypes.PlayerView memory v = player.playerView(ids[1]);
        assertGt(bytes(bare.imageOf(ids[1], v.dna, v.appearance, v.core.position)).length, 200);
    }

    // ------------------------------------------------------ authority

    function test_onlyTheNftOwnerCanJoinATeam() public {
        vm.expectRevert(abi.encodeWithSelector(FobalSquadRegistry.NotPlayerOwner.selector, ids[7]));
        vm.prank(bob);
        squads.join(ids[7], teamB);
    }

    function test_eitherPartyCanRelease() public {
        vm.prank(alice);
        squads.join(ids[8], teamA);
        // the club can let a player go...
        vm.prank(alice);
        squads.release(ids[8]);
        assertEq(squads.teamOf(ids[8]), 0);

        vm.prank(alice);
        squads.join(ids[8], teamB);      // alice owns the token, bob owns teamB
        vm.prank(bob);                    // ...and so can the club owner
        squads.release(ids[8]);
        assertEq(squads.teamOf(ids[8]), 0);
    }

    function test_cannotJoinANonexistentTeam() public {
        vm.expectRevert(abi.encodeWithSelector(FobalSquadRegistry.NoSuchTeam.selector, uint64(4242)));
        vm.prank(alice);
        squads.join(ids[9], 4242);
    }

    function test_movingClubsEmitsBothReleaseAndJoin() public {
        vm.startPrank(alice);
        squads.join(ids[10], teamA);
        vm.expectEmit(true, true, true, true);
        emit FobalSquadRegistry.PlayerReleased(ids[10], teamA, alice);
        vm.expectEmit(true, true, true, true);
        emit FobalSquadRegistry.PlayerJoined(ids[10], teamB, alice);
        squads.join(ids[10], teamB);
        vm.stopPrank();
    }

    function test_onlyTheClubOwnerSetsKits() public {
        vm.expectRevert(abi.encodeWithSelector(FobalKitRegistry.NotTeamOwner.selector, teamA));
        vm.prank(bob);
        wardrobe.setKit(teamA, 0, 1, 2, 3, 0);

        vm.expectRevert(abi.encodeWithSelector(FobalKitRegistry.BadSlot.selector, uint8(9)));
        vm.prank(alice);
        wardrobe.setKit(teamA, 9, 1, 2, 3, 0);

        vm.expectRevert(abi.encodeWithSelector(FobalKitRegistry.BadPattern.selector, uint8(99)));
        vm.prank(alice);
        wardrobe.setKit(teamA, 0, 1, 2, 3, 99);
    }

    // -------------------------------------------------------- invariants

    function testFuzz_faceIsIndependentOfEveryClubDecision(uint24 p, uint24 s, uint8 pattern) public {
        pattern = uint8(bound(pattern, 0, 6));
        uint256 id = ids[2];
        bytes32 faceBefore = _face(id);
        vm.startPrank(alice);
        wardrobe.setKit(teamA, wardrobe.HOME(), p, s, p, pattern);
        if (squads.teamOf(id) != teamA) squads.join(id, teamA);
        vm.stopPrank();
        assertEq(_face(id), faceBefore, "no club decision can alter a face");
    }

    function test_tokenUriWorksEndToEnd() public {
        vm.startPrank(alice);
        wardrobe.setKit(teamA, wardrobe.HOME(), 0x2f6fd0, 0xf2f4f8, 0xf2f4f8, 2);
        squads.join(ids[1], teamA);
        vm.stopPrank();
        // installing a renderer is governance, not a club decision
        vm.prank(admin);
        player.setRenderer(IFobalRenderer(address(r2)));
        string memory uri = player.tokenURI(ids[1]);
        assertGt(bytes(uri).length, 500);
    }
}
