// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Script.sol";
import {FobalDeployer} from "./FobalDeployer.sol";

/// @notice Deploys the whole protocol and wires roles, reading configuration
/// from the environment so no secrets or addresses are ever committed:
///   FOBAL_ADMIN            governance authority (multisig on mainnet)
///   FOBAL_TREASURY         fee/pot recipient
///   FOBAL_GENERATOR_SIGNER EIP-712 squad generation signer
///   FOBAL_ENGINE_SIGNER    EIP-712 match-result signer
/// Writes a machine-readable deployment artifact for the frontend/indexer.
///
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
contract Deploy is FobalDeployer {
    function run() external returns (Deployment memory d) {
        address admin = vm.envAddress("FOBAL_ADMIN");
        address treasury = vm.envAddress("FOBAL_TREASURY");
        address generatorSigner = vm.envAddress("FOBAL_GENERATOR_SIGNER");
        address engineSigner = vm.envAddress("FOBAL_ENGINE_SIGNER");

        // broadcaster MUST be the admin so it can grant roles during wiring
        vm.startBroadcast();
        d = _deployAndWire(admin, treasury, generatorSigner, engineSigner);
        vm.stopBroadcast();

        _writeArtifact(d);
        _log(d);
    }

    function _writeArtifact(Deployment memory d) internal {
        string memory json = string.concat(
            "{\n",
            '  "chainId": "',
            vm.toString(block.chainid),
            '",\n',
            '  "FobalPlayer": "',
            vm.toString(address(d.player)),
            '",\n',
            '  "FobalAvatarRenderer": "',
            vm.toString(address(d.renderer)),
            '",\n',
            '  "FobalPlayerGenerator": "',
            vm.toString(address(d.generator)),
            '",\n',
            '  "FobalTeamRegistry": "',
            vm.toString(address(d.teams)),
            '",\n',
            '  "FobalAssetRegistry": "',
            vm.toString(address(d.assets)),
            '",\n',
            '  "FobalProgression": "',
            vm.toString(address(d.progression)),
            '",\n',
            '  "FobalMatchEscrow": "',
            vm.toString(address(d.escrow)),
            '",\n',
            '  "FobalMarketplace": "',
            vm.toString(address(d.market)),
            '"\n',
            "}\n"
        );
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeFile(path, json);
        console2.log("deployment artifact written:", path);
    }

    function _log(Deployment memory d) internal pure {
        console2.log("FobalPlayer          ", address(d.player));
        console2.log("FobalAvatarRenderer  ", address(d.renderer));
        console2.log("FobalPlayerGenerator ", address(d.generator));
        console2.log("FobalTeamRegistry    ", address(d.teams));
        console2.log("FobalAssetRegistry   ", address(d.assets));
        console2.log("FobalProgression     ", address(d.progression));
        console2.log("FobalMatchEscrow     ", address(d.escrow));
        console2.log("FobalMarketplace     ", address(d.market));
    }
}
