// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FobalArtLibrary} from "../src/FobalArtLibrary.sol";
import {FobalFaceComposer} from "../src/art/FobalFaceComposer.sol";
import {FobalKitComposer} from "../src/art/FobalKitComposer.sol";
import {FobalSquadRegistry, ITeamsRead, IOwnerOf} from "../src/art/FobalSquadRegistry.sol";
import {FobalKitRegistry} from "../src/art/FobalKitRegistry.sol";
import {FobalRendererV2_1, IPlayerReader2} from "../src/art/FobalRendererV2_1.sol";

/// Deploys the P4 kit stack against an already-deployed art library.
/// Nothing is installed: the router decides which tokens use this, and only
/// after the rendered output has been inspected on chain.
///
///   FOBAL_PLAYER=0x… FOBAL_TEAM_REGISTRY=0x… FOBAL_ART_LIBRARY=0x… \
///   forge script script/DeployKits.s.sol --rpc-url base_sepolia \
///     --account fobal-admin --broadcast --verify
contract DeployKits is Script {
    function run()
        external
        returns (FobalSquadRegistry squads, FobalKitRegistry wardrobe, FobalRendererV2_1 renderer)
    {
        address playerAddr = vm.envAddress("FOBAL_PLAYER");
        address teamsAddr = vm.envAddress("FOBAL_TEAM_REGISTRY");
        address artAddr = vm.envAddress("FOBAL_ART_LIBRARY");

        vm.startBroadcast();
        squads = new FobalSquadRegistry(IOwnerOf(playerAddr), ITeamsRead(teamsAddr));
        wardrobe = new FobalKitRegistry(ITeamsRead(teamsAddr));
        renderer = new FobalRendererV2_1(
            IPlayerReader2(playerAddr),
            new FobalFaceComposer(FobalArtLibrary(artAddr)),
            new FobalKitComposer(),
            squads,
            wardrobe
        );
        vm.stopBroadcast();

        console2.log("squad registry ", address(squads));
        console2.log("kit registry   ", address(wardrobe));
        console2.log("renderer v2.1  ", address(renderer));
        console2.log("NOT installed: pin one token on the router, inspect, then widen");
    }
}
