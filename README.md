# ☢️ Berkayprof's Discord Nuke Bot

> **Disclaimer:** This bot modifies Discord servers into a unrestorable state. All channels, roles and more will be deleted. You may exclusivly use this bot on servers that you own or have explicit permission to use it on.

## Overview

This is a feature-rich Discord.js nuke bot. It has all config options, and works with multiple servers at once!

## Features

Berkayprof's Nuke bot includes the following features:

- Owner ID configuration
- Processing multiple guilds with configurable concurrency
- Configurable channel and message settings
- Excluding selected guilds from bulk operations
- Saving job state for possible recovery
- Logging to a file with log rotation
- Optional automatic leaving from a guild after an operation
- Change server name/ icon
- Delete server integrations
- Advanced async execution for swiftness

## Tech Stack

- **Node.js**
- **discord.js**
- **dotenv**

## Requirements

- Node.js compatible with the selected `discord.js` version
- This repository
- An Discord test server that you have explicit permission to nuke on

## Setup

1. Clone/ download this repository
2. Copy `.env.example` to `.env`
3. Edit `.env` to change the config to your preference
4. Run `npm install`
5. Run `npm start` to run the bot

## Usage

**General**
- `!nuke help` — this overview
- `!nuke status` — progress of a running job
- `!abort` — stops the running nuke

**Nuking**
- `!nuke [count]` — nukes this server (count = messages per channel)
- `!nuke all [count]` — nukes all servers except the blacklist
- `!confirm` — confirms `!nuke all` (valid for 5 min)

**Recovery**
- `!nuke resume` — resumes an interrupted run
- `!nuke force` — ignores a pending run (state is cleared)

## Contributing

You can contribute to the project by following these steps:

1. Clone this repo
2. Make your changes
3. Open a PR (Pull Request) from your clone to this repo
