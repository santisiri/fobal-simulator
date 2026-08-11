// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FobalPlayer} from "../src/FobalPlayer.sol";
import {FobalAvatarRenderer, IPlayerReader} from "../src/FobalAvatarRenderer.sol";
import {FobalPlayerGenerator} from "../src/FobalPlayerGenerator.sol";
import {FobalTeamRegistry} from "../src/FobalTeamRegistry.sol";
import {FobalAssetRegistry} from "../src/FobalAssetRegistry.sol";
import {FobalProgression} from "../src/FobalProgression.sol";
import {FobalMatchEscrow} from "../src/FobalMatchEscrow.sol";
import {FobalMarketplace} from "../src/FobalMarketplace.sol";
import {IFobalPlayer, FobalTypes} from "../src/interfaces/IFobalPlayer.sol";
import {PlayerCodec} from "../src/libraries/PlayerCodec.sol";

/// @notice Deploys the whole protocol with realistic wiring and provides
/// signing/minting helpers shared by every suite.
contract BaseFixture is Test {
    FobalPlayer internal player;
    FobalAvatarRenderer internal renderer;
    FobalPlayerGenerator internal generator;
    FobalTeamRegistry internal teams;
    FobalAssetRegistry internal assets;
    FobalProgression internal progression;
    FobalMatchEscrow internal escrow;
    FobalMarketplace internal market;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal generatorPk = 0xA11CE0;
    uint256 internal enginePk = 0xE41123;
    address internal generatorSigner;
    address internal engineSigner;

    function setUp() public virtual {
        generatorSigner = vm.addr(generatorPk);
        engineSigner = vm.addr(enginePk);

        player = new FobalPlayer(admin);
        renderer = new FobalAvatarRenderer(IPlayerReader(address(player)));
        generator = new FobalPlayerGenerator(IFobalPlayer(address(player)), admin, generatorSigner);
        teams = new FobalTeamRegistry();
        assets = new FobalAssetRegistry(admin);
        progression = new FobalProgression(IFobalPlayer(address(player)), admin);
        escrow = new FobalMatchEscrow(
            IFobalPlayer(address(player)), assets, progression, admin, engineSigner, treasury
        );
        market = new FobalMarketplace(IFobalPlayer(address(player)), assets, admin, treasury);

        vm.startPrank(admin);
        player.grantRole(player.MINTER_ROLE(), address(generator));
        player.grantRole(player.PROGRESSION_ROLE(), address(progression));
        player.grantRole(player.LOCK_ROLE(), address(escrow));
        progression.grantRole(progression.ESCROW_ROLE(), address(escrow));
        player.setRenderer(renderer);
        assets.setAsset(
            address(0),
            FobalAssetRegistry.AssetConfig({
                enabled: true, minStake: 0.001 ether, maxStake: 100 ether, progressionMultiplierBps: 10_000
            })
        );
        vm.stopPrank();

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    // ------------------------------------------------------------ seed tools

    function packSkills(uint8[12] memory values) internal pure returns (uint256 packed) {
        for (uint256 i; i < 12; ++i) {
            packed = PlayerCodec.setSkill(packed, i, values[i]);
        }
    }

    function flatSkills(uint8 value) internal pure returns (uint256) {
        uint8[12] memory v;
        for (uint256 i; i < 12; ++i) {
            v[i] = value;
        }
        return packSkills(v);
    }

    function makeSeed(string memory name, uint8 position, uint256 salt)
        internal
        pure
        returns (FobalTypes.PlayerSeed memory)
    {
        bytes32 dna = keccak256(abi.encodePacked("fobal-dna", name, salt));
        // 55 average keeps an 11-squad comfortably under the 720/player budget
        uint256 skills = flatSkills(55);
        if (position == 0) skills = PlayerCodec.setSkill(skills, 11, 85); // GK lane
        // appearance nibbles carved from dna — varied but deterministic
        uint256 appearance = uint256(dna) & PlayerCodec.APPEARANCE_MASK;
        return FobalTypes.PlayerSeed({
            name: name,
            dna: dna,
            skills: skills,
            appearance: appearance,
            generation: 1,
            country: 32, // Argentina
            position: position
        });
    }

    function makeSquad(uint256 count) internal pure returns (FobalTypes.PlayerSeed[] memory seeds) {
        seeds = new FobalTypes.PlayerSeed[](count);
        for (uint256 i; i < count; ++i) {
            uint8 position = i == 0 ? 0 : uint8(1 + (i % 3));
            seeds[i] = makeSeed(string.concat("Player ", vm.toString(i + 1)), position, i);
        }
    }

    // -------------------------------------------------------------- signing

    function signSquad(
        address recipient,
        uint64 teamId,
        uint32 generation,
        uint256 nonce,
        uint256 deadline,
        FobalTypes.PlayerSeed[] memory seeds
    ) internal view returns (bytes memory) {
        FobalTypes.PlayerSeed[] memory tmp = seeds;
        bytes32 digest = _squadDigestMemory(recipient, teamId, generation, nonce, deadline, tmp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(generatorPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _squadDigestMemory(
        address recipient,
        uint64 teamId,
        uint32 generation,
        uint256 nonce,
        uint256 deadline,
        FobalTypes.PlayerSeed[] memory seeds
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                generator.SQUAD_MINT_TYPEHASH(),
                recipient,
                teamId,
                generation,
                nonce,
                deadline,
                keccak256(abi.encode(seeds))
            )
        );
        return _hashTypedData(address(generator), "FobalPlayerGenerator", structHash);
    }

    function signResult(FobalMatchEscrow.MatchResult memory result) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                escrow.MATCH_RESULT_TYPEHASH(),
                result.matchId,
                result.resultNonce,
                result.teamA,
                result.teamB,
                result.scoreA,
                result.scoreB,
                result.replayHash,
                result.statsRoot,
                result.progressionHash,
                result.deadline
            )
        );
        bytes32 digest = _hashTypedData(address(escrow), "FobalMatchEscrow", structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(enginePk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _hashTypedData(address verifying, string memory name, bytes32 structHash)
        internal
        view
        returns (bytes32)
    {
        bytes32 domainSeparator = keccak256(
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
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    // ------------------------------------------------------------- shortcuts

    function mintSquadFor(address recipient, uint64 teamId, uint256 count)
        internal
        returns (uint256[] memory tokenIds)
    {
        FobalTypes.PlayerSeed[] memory seeds = makeSquad(count);
        uint256 nonce = generator.nonces(recipient);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signSquad(recipient, teamId, 1, nonce, deadline, seeds);
        tokenIds = generator.mintSquad(recipient, teamId, 1, deadline, seeds, sig);
    }

    function defaultProgress(uint256 playerId, uint8 result)
        internal
        pure
        returns (FobalTypes.PlayerProgress memory)
    {
        uint256 deltas = PlayerCodec.setSkill(0, 1, 1); // +1 finishing
        deltas = PlayerCodec.setSkill(deltas, 2, 1); // +1 passing
        return FobalTypes.PlayerProgress({
            playerId: playerId,
            delta: FobalTypes.ProgressionDelta({
                xp: 80, skillDeltas: deltas, result: result, goals: 2, assists: 1, cleanSheet: false
            })
        });
    }
}
