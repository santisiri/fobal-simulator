// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FobalPlayerGenerator} from "../src/FobalPlayerGenerator.sol";
import {FobalTeamRegistry} from "../src/FobalTeamRegistry.sol";
import {FobalTypes} from "../src/interfaces/IFobalPlayer.sol";
import {PlayerCodec} from "../src/libraries/PlayerCodec.sol";

/// @notice TESTNET squad bootstrap: registry team + generator-signed 11 +
/// declared roster, in one run — everything the lobby's D1 reader needs to
/// serve a playable squad. Production minting will be a signed SERVICE; this
/// script is the runbook's stand-in until that exists, which is why it takes
/// raw keys from the environment — TESTNET THROWAWAY KEYS ONLY, never a key
/// that ever touches value.
///
///   FOBAL_GENERATOR_PK   generator signer key (must match the deployed
///                        generator's signer address)
///   FOBAL_RECIPIENT_PK   the testnet wallet that will OWN the squad (also
///                        pays gas — fund it first; import the same key into
///                        the browser wallet to sign in at the lobby)
///   FOBAL_TEAM_NAME      registry team name (default "MY FOBAL XI")
///
/// Contract addresses come from deployments/<chainId>.json (Deploy.s.sol's
/// artifact). Run:
///   forge script script/MintSquad.s.sol --rpc-url base_sepolia --broadcast
contract MintSquad is Script {
    function run() external {
        uint256 generatorPk = vm.envUint("FOBAL_GENERATOR_PK");
        uint256 ownerPk = vm.envUint("FOBAL_RECIPIENT_PK");
        string memory teamName = vm.envOr("FOBAL_TEAM_NAME", string("MY FOBAL XI"));
        address owner = vm.addr(ownerPk);

        string memory artifact =
            vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        FobalPlayerGenerator generator =
            FobalPlayerGenerator(vm.parseJsonAddress(artifact, ".FobalPlayerGenerator"));
        FobalTeamRegistry teams = FobalTeamRegistry(vm.parseJsonAddress(artifact, ".FobalTeamRegistry"));

        vm.startBroadcast(ownerPk);
        uint64 teamId = teams.createTeam(teamName, keccak256(abi.encodePacked(owner, teamName)));
        vm.stopBroadcast();

        // the demo squad shape: GK first, then a DF/MF/FW rotation — the
        // roster order doubles as the XI, and the XI needs its GK up front
        FobalTypes.PlayerSeed[] memory seeds = new FobalTypes.PlayerSeed[](11);
        for (uint256 i; i < 11; ++i) {
            bytes32 dna = keccak256(abi.encodePacked(owner, teamId, i));
            uint8 position = i == 0 ? 0 : uint8(1 + (i % 3));
            uint256 skills = _flat(55);
            if (position == 0) skills = PlayerCodec.setSkill(skills, 11, 85);
            seeds[i] = FobalTypes.PlayerSeed({
                name: string.concat("Player ", vm.toString(i + 1)),
                dna: dna,
                skills: skills,
                appearance: uint256(dna) & PlayerCodec.APPEARANCE_MASK,
                generation: 1,
                country: 32,
                position: position
            });
        }

        uint256 nonce = generator.nonces(owner);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                generator.SQUAD_MINT_TYPEHASH(),
                owner,
                teamId,
                uint32(1),
                nonce,
                deadline,
                keccak256(abi.encode(seeds))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(generatorPk, _domain(address(generator), "FobalPlayerGenerator", structHash));

        vm.startBroadcast(ownerPk);
        uint256[] memory ids = generator.mintSquad(owner, teamId, 1, deadline, seeds, abi.encodePacked(r, s, v));
        teams.declareRoster(teamId, ids);
        vm.stopBroadcast();

        console2.log("registry team id (use this at the lobby's LINK NFT SQUAD):", teamId);
        console2.log("owner:", owner);
        console2.log("tokens:", ids[0], "..", ids[10]);
    }

    function _flat(uint8 value) internal pure returns (uint256 packed) {
        for (uint256 i; i < 12; ++i) {
            packed = PlayerCodec.setSkill(packed, i, value);
        }
    }

    function _domain(address verifying, string memory name, bytes32 structHash)
        internal
        view
        returns (bytes32)
    {
        bytes32 sep = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                verifying
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", sep, structHash));
    }
}
