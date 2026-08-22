// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FobalArtLibrary} from "../../src/FobalArtLibrary.sol";
import {FobalArtConstants as K} from "../../src/art/FobalArtConstants.sol";
import {FobalFaceComposer} from "../../src/art/FobalFaceComposer.sol";
import {FobalKitComposer} from "../../src/art/FobalKitComposer.sol";
import {FobalSquadRegistry} from "../../src/art/FobalSquadRegistry.sol";
import {FobalKitRegistry} from "../../src/art/FobalKitRegistry.sol";
import {FobalRendererV2_1, IPlayerReader2} from "../../src/art/FobalRendererV2_1.sol";
import {FobalTypes} from "../../src/interfaces/IFobalPlayer.sol";

interface ILive {
    function playerView(uint256) external view returns (FobalTypes.PlayerView memory);
    function nextTokenId() external view returns (uint256);
    function tokenURI(uint256) external view returns (string memory);
}

/// THE FREE CHECKPOINT. Deploys the entire v2 stack onto a FORK of Base
/// Sepolia and renders the REAL minted tokens with it — no gas, no state
/// change, nothing installed. This is what the collection will look like
/// after the rollout, decided before committing to it.
contract LiveSquadPreviewTest is Test {
    address constant PLAYER = 0x52F5828dA509D6043c2619F048687BEdfA4789d4;
    /// @dev the GENERATED install list — see FobalArtConstants.classNames()
    bytes32[] internal CLASSES = K.classNames();

    function _name(bytes32 k) internal pure returns (string memory) {
        uint256 n;
        while (n < 32 && k[n] != 0) ++n;
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) b[i] = k[i];
        return string(b);
    }

    function test_previewLiveSquad() public {
        if (block.chainid != 84532) {
            emit log("skipped: not forked onto Base Sepolia");
            return;
        }
        FobalArtLibrary art = new FobalArtLibrary(address(this));
        for (uint256 i; i < CLASSES.length; ++i) {
            string memory h = vm.readFile(
                string.concat(vm.projectRoot(), "/../packages/art/gen/blobs/", _name(CLASSES[i]), ".hex")
            );
            art.setClass(CLASSES[i], vm.parseBytes(vm.replace(h, "\n", "")));
        }
        FobalRendererV2_1 r2 = new FobalRendererV2_1(
            IPlayerReader2(PLAYER),
            new FobalFaceComposer(art),
            new FobalKitComposer(),
            FobalSquadRegistry(address(0)),   // free agents: no club assigned yet
            FobalKitRegistry(address(0))
        );

        ILive live = ILive(PLAYER);
        uint256 supply = live.nextTokenId();
        for (uint256 id = 1; id < supply; ++id) {
            FobalTypes.PlayerView memory v = live.playerView(id);
            emit log_named_string("NAME", v.name);
            emit log_named_string("SVG", r2.imageOf(id, v.dna, v.appearance, v.core.position));
        }
        emit log_named_uint("live tokens previewed", supply - 1);
    }
}
