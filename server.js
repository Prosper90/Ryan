const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Web3 } = require('web3');
const mongoose = require('mongoose');
require('dotenv').config();

// Config
const config = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    MONGODB_URI: process.env.MONGODB_URI,
    WEB3_PROVIDER: process.env.WEB3_PROVIDER,
    CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    MAX_USERS: 1000, // Maximum number of participants
    AIRDROP_AMOUNT: '10000000000000000', // Amount in wei
};

// User Schema
const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    walletAddress: { type: String, required: true, unique: true },
    username: { type: String },
    joinDate: { type: Date, default: Date.now },
    hasReceived: { type: Boolean, default: false },
    transactionHash: { type: String },
});

const User = mongoose.model('User', userSchema);

// Initialize Web3
const web3 = new Web3(config.WEB3_PROVIDER);
const account = web3.eth.accounts.privateKeyToAccount(config.PRIVATE_KEY);
web3.eth.accounts.wallet.add(account);

// Initialize bot
const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

// Connect to MongoDB
mongoose.connect(config.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

// Contract ABI
const contractABI = [
    {
        "constant": false,
        "inputs": [
            {
                "name": "_to",
                "type": "address"
            },
            {
                "name": "_value",
                "type": "uint256"
            }
        ],
        "name": "transfer",
        "outputs": [
            {
                "name": "",
                "type": "bool"
            }
        ],
        "payable": false,
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

const contract = new web3.eth.Contract(contractABI, config.CONTRACT_ADDRESS);

// Welcome message
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    
    const welcomeMessage = `Welcome to the Airdrop Bot! 🚀\n\n` +
        `To participate in the airdrop:\n` +
        `1. Please send your BSC wallet address\n` +
        `2. Make sure you're using a valid address\n` +
        `3. Each address can only participate once\n\n` +
        `Type /help for more information.`;
    
    bot.sendMessage(chatId, welcomeMessage);
});

// Help command
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpMessage = `Airdrop Bot Commands:\n\n` +
        `/start - Start the bot\n` +
        `/help - Show this help message\n` +
        `/status - Check your airdrop status\n\n` +
        `Simply send your BSC wallet address to participate.`;
    
    bot.sendMessage(chatId, helpMessage);
});

// Handle wallet addresses
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    // Ignore commands
    if (text.startsWith('/')) return;
    
    // Check if message is a valid Ethereum address
    if (web3.utils.isAddress(text)) {
        try {
            // Check if user already exists
            const existingUser = await User.findOne({ telegramId: msg.from.id });
            if (existingUser) {
                return bot.sendMessage(chatId, 'You have already participated in the airdrop! 🚫');
            }
            
            // Check if address already used
            const existingAddress = await User.findOne({ walletAddress: text });
            if (existingAddress) {
                return bot.sendMessage(chatId, 'This wallet address has already been used! 🚫');
            }
            
            // Check if max users reached
            const userCount = await User.countDocuments();
            if (userCount >= config.MAX_USERS) {
                return bot.sendMessage(chatId, 'Sorry, the airdrop has reached maximum participants! 🚫');
            }
            
            // Create new user
            const user = new User({
                telegramId: msg.from.id,
                walletAddress: text,
                username: msg.from.username,
            });
            
            // Save user
            await user.save();
            
            // Attempt to send tokens
            try {
                const receipt = await contract.methods.transfer(text, config.AIRDROP_AMOUNT)
                    .send({ from: account.address, gas: 100000 });
                
                // Update user with transaction hash
                user.hasReceived = true;
                user.transactionHash = receipt.transactionHash;
                await user.save();
                
                bot.sendMessage(chatId, 
                    `✅ Airdrop successful!\n\n` +
                    `Transaction Hash: ${receipt.transactionHash}\n\n` +
                    `You can check the transaction on Etherscan.`
                );
            } catch (error) {
                console.error('Transfer error:', error);
                bot.sendMessage(chatId, 'There was an error processing your airdrop. Please try again later. ❌');
            }
            
        } catch (error) {
            console.error('Database error:', error);
            bot.sendMessage(chatId, 'An error occurred. Please try again later. ❌');
        }
    } else {
        bot.sendMessage(chatId, 'Please send a valid Ethereum wallet address! 🚫');
    }
});

// Status command
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const user = await User.findOne({ telegramId: msg.from.id });
        if (!user) {
            return bot.sendMessage(chatId, 'You haven\'t participated in the airdrop yet! Send your BSC wallet address to participate.');
        }
        
        const status = user.hasReceived ? 
            `✅ Airdrop received!\nTransaction Hash: ${user.transactionHash}` :
            '⏳ Pending...';
            
        bot.sendMessage(chatId, `Status: ${status}`);
    } catch (error) {
        console.error('Status check error:', error);
        bot.sendMessage(chatId, 'Error checking status. Please try again later.');
    }
});

// Express server setup
const app = express();
const PORT = process.env.PORT || 3000;

// Winners list endpoint
app.get('/winners', async (req, res) => {
    try {
        const winners = await User.find({ hasReceived: true })
            .select('username walletAddress joinDate transactionHash -_id')
            .sort({ joinDate: 'asc' });

        // Format the data for better readability
        const formattedWinners = winners.map(winner => ({
            username: winner.username || 'Anonymous',
            walletAddress: winner.walletAddress,
            joinDate: winner.joinDate.toLocaleDateString(),
            transactionHash: winner.transactionHash
        }));

        res.json({
            total: winners.length,
            winners: formattedWinners
        });
    } catch (error) {
        console.error('Error fetching winners:', error);
        res.status(500).json({ error: 'Error fetching winners list' });
    }
});

// Health check endpoint
app.get('/', (req, res) => {
    res.send('Bot is running...');
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});