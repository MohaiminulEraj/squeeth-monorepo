// SPDX-License-Identifier: MIT

pragma solidity >=0.8.0 <0.9.0;

interface IController {
    function vaultNFT() external view returns (address);

    function squeeth() external view returns (address);

    /**
     * put down collateral and mint squeeth.
     */
    function mint(uint256 _vaultId, uint128 _mintAmount) external payable returns (uint256);

    /**
     * Deposit collateral into a vault
     */
    function deposit(uint256 _vaultId) external payable;

    /**
     * Withdraw collateral from a vault.
     */
    function withdraw(uint256 _vaultId, uint256 _amount) external payable;

    /**
     * burn squueth and remove collateral from a vault.
     */
    function burn(
        uint256 _vaultId,
        uint256 _amount,
        uint256 _withdrawAmount
    ) external returns (uint256);

    /**
     * External function to update the normalized factor as a way to pay funding.
     */
    function applyFunding() external;
}