// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "../BaseFixture.sol";
import {FobalPlayer} from "../../src/FobalPlayer.sol";
import {FobalTypes} from "../../src/interfaces/IFobalPlayer.sol";
import {IFobalRenderer} from "../../src/interfaces/IFobalRenderer.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// `setRenderer` is the lever the entire art migration rides on, and it had
/// ZERO test coverage. These four tests pin its contract down before P1
/// points it at anything new.
contract SetRendererTest is BaseFixture {
    uint256[] internal ids;

    function setUp() public override {
        super.setUp();
        ids = mintSquadFor(alice, 1, 11);
    }

    function test_onlyAdmin_canSetRenderer() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, bob, bytes32(0)
            )
        );
        vm.prank(bob);
        player.setRenderer(IFobalRenderer(address(renderer)));
    }

    /// The refresh lever: a swap must tell every marketplace to re-pull the
    /// WHOLE supply, with exact bounds.
    function test_setRenderer_emitsBatchMetadataUpdateOverEntireSupply() public {
        vm.expectEmit(true, true, true, true);
        emit IERC4906.BatchMetadataUpdate(1, player.nextTokenId() - 1);
        vm.prank(admin);
        player.setRenderer(IFobalRenderer(address(renderer)));
    }

    /// Re-installing the SAME address is legal and still refreshes — this is
    /// how a no-op "please re-render" transaction is issued.
    function test_sameAddress_isNotGuarded_andStillRefreshes() public {
        assertEq(address(player.renderer()), address(renderer));
        vm.expectEmit(true, true, true, true);
        emit IERC4906.BatchMetadataUpdate(1, player.nextTokenId() - 1);
        vm.prank(admin);
        player.setRenderer(IFobalRenderer(address(renderer)));
        assertEq(address(player.renderer()), address(renderer));
    }

    /// A renderer swap restyles; it must never RE-IDENTIFY. Identity fields
    /// are write-once at mint and no renderer can touch them.
    function test_identitySurvivesRendererSwap() public {
        FobalTypes.PlayerView memory before = player.playerView(ids[3]);
        vm.prank(admin);
        player.setRenderer(IFobalRenderer(address(renderer)));
        FobalTypes.PlayerView memory afterSwap = player.playerView(ids[3]);
        assertEq(afterSwap.dna, before.dna, "dna is immutable");
        assertEq(afterSwap.appearance, before.appearance, "appearance is immutable");
        assertEq(afterSwap.skills, before.skills, "skills untouched by a renderer swap");
        assertEq(afterSwap.name, before.name, "name is immutable");
        assertEq(afterSwap.owner, before.owner, "ownership untouched");
        assertEq(afterSwap.core.generation, before.core.generation);
        assertEq(afterSwap.core.position, before.core.position);
    }

    /// A candidate that does not answer version() cannot be installed — the
    /// cheapest possible interface check, and the reason to keep it.
    function test_rendererWithoutVersion_cannotBeInstalled() public {
        address notARenderer = address(new NoVersion());
        vm.prank(admin);
        vm.expectRevert();
        player.setRenderer(IFobalRenderer(notARenderer));
    }

    /// Existence is checked BEFORE the renderer, so an unminted id reports
    /// ERC721NonexistentToken; RendererUnset only guards tokens that exist.
    function test_tokenUri_revertsWhenRendererUnset() public {
        FobalPlayer fresh = new FobalPlayer(admin);
        vm.startPrank(admin);
        fresh.grantRole(fresh.MINTER_ROLE(), admin);
        uint256 id = fresh.mint(alice, makeSeed("Unset", 1, 7));
        vm.stopPrank();
        vm.expectRevert(FobalPlayer.RendererUnset.selector);
        fresh.tokenURI(id);
    }
}

contract NoVersion {
    function tokenURI(uint256) external pure returns (string memory) {
        return "x";
    }
}
