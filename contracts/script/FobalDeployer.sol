// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {FobalPlayer} from "../src/FobalPlayer.sol";
import {FobalAvatarRenderer, IPlayerReader} from "../src/FobalAvatarRenderer.sol";
import {FobalPlayerGenerator} from "../src/FobalPlayerGenerator.sol";
import {FobalTeamRegistry} from "../src/FobalTeamRegistry.sol";
import {FobalAssetRegistry} from "../src/FobalAssetRegistry.sol";
import {FobalProgression} from "../src/FobalProgression.sol";
import {FobalMatchEscrow} from "../src/FobalMatchEscrow.sol";
import {FobalMarketplace} from "../src/FobalMarketplace.sol";
import {IFobalPlayer} from "../src/interfaces/IFobalPlayer.sol";

/// @notice Shared deploy + wiring, run INLINE inside the caller's broadcast
/// so the admin EOA is msg.sender for every role grant (an intermediate
/// contract would become the caller and fail the AccessControl checks).
abstract contract FobalDeployer is Script {
    struct Deployment {
        FobalPlayer player;
        FobalAvatarRenderer renderer;
        FobalPlayerGenerator generator;
        FobalTeamRegistry teams;
        FobalAssetRegistry assets;
        FobalProgression progression;
        FobalMatchEscrow escrow;
        FobalMarketplace market;
    }

    /// @dev MUST be called while broadcasting as `admin` (admin == msg.sender).
    function _deployAndWire(address admin, address treasury, address generatorSigner, address engineSigner)
        internal
        returns (Deployment memory d)
    {
        d.player = new FobalPlayer(admin);
        d.renderer = new FobalAvatarRenderer(IPlayerReader(address(d.player)));
        d.generator = new FobalPlayerGenerator(IFobalPlayer(address(d.player)), admin, generatorSigner);
        d.teams = new FobalTeamRegistry();
        d.assets = new FobalAssetRegistry(admin);
        d.progression = new FobalProgression(IFobalPlayer(address(d.player)), admin);
        d.escrow = new FobalMatchEscrow(
            IFobalPlayer(address(d.player)), d.assets, d.progression, admin, engineSigner, treasury
        );
        d.market = new FobalMarketplace(IFobalPlayer(address(d.player)), d.assets, admin, treasury);

        d.player.grantRole(d.player.MINTER_ROLE(), address(d.generator));
        d.player.grantRole(d.player.PROGRESSION_ROLE(), address(d.progression));
        d.player.grantRole(d.player.LOCK_ROLE(), address(d.escrow));
        d.progression.grantRole(d.progression.ESCROW_ROLE(), address(d.escrow));
        d.player.setRenderer(d.renderer);

        d.assets
            .setAsset(
                address(0),
                FobalAssetRegistry.AssetConfig({
                    enabled: true,
                    minStake: 0.0001 ether,
                    maxStake: 100 ether,
                    progressionMultiplierBps: 10_000
                })
            );
    }
}
