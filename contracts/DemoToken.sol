// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Minimal ERC20 example with fixed supply and no privileged minting.
contract DemoToken {
    string public constant name = "StarCoin Demo Token";
    string public constant symbol = "SDT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }
    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value); return true;
    }
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value); return true;
    }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "ERC20: insufficient allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value); return true;
    }
    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "ERC20: zero recipient");
        require(balanceOf[from] >= value, "ERC20: insufficient balance");
        balanceOf[from] -= value; balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
