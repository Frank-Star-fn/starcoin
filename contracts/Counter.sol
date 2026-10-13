// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract Counter {
    uint256 public count;
    event ValueChanged(address indexed sender, uint256 value);
    function set(uint256 value) external { count = value; emit ValueChanged(msg.sender, value); }
    function increment() external { count += 1; emit ValueChanged(msg.sender, count); }
    function fail() external pure { revert("Counter: intentional revert"); }
}
