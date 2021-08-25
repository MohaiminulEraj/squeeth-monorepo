//SPDX-License-Identifier: MIT

pragma solidity >=0.8.0 <0.9.0;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";

contract MockVaultNFTManager is ERC721Upgradeable {
    uint256 public nextId = 1;

    function mintNFT(address _recipient) external returns (uint256 tokenId) {
        _mint(_recipient, (tokenId = nextId++));
    }

    function burnNFT(uint256 _tokenId) external {
        _burn(_tokenId);
    }
}