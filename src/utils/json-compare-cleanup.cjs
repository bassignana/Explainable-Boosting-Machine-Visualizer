/**
 * Model Files Cleanup Script
 * -------------------------
 * Purpose: This script cleans up the Downloads folder by removing all files that were
 * created for comparing model inputs/outputs between different projects.
 *
 * This is a companion script to compare-init-plans.js. After you're done comparing
 * the model outputs, you can run this script to remove all the comparison files
 * and keep your Downloads folder clean.
 *
 * Files removed will match the pattern:
 * '{new|old}-initPlans-input-{object}.json'
 *
 * Usage:
 * > node cleanup-init-plans.js
 *
 * WARNING: This script permanently deletes files. Make sure you have saved any
 * important results before running it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

/**
 * Find all matching files in downloads directory
 * @returns {Promise<string[]>} Array of matching file paths
 */
const findMatchingFiles = async () => {
    const downloadsPath = path.join(os.homedir(), 'Downloads');
    const files = await fs.promises.readdir(downloadsPath);
    const filePattern = /^(new|old)-initPlans-input-.+\.json$/;

    return files
        .filter(file => filePattern.test(file))
        .map(file => ({
            name: file,
            path: path.join(downloadsPath, file)
        }));
};

/**
 * Remove the specified files
 * @param {Array<{name: string, path: string}>} files Files to remove
 */
const removeFiles = async (files) => {
    let filesRemoved = 0;
    let errors = 0;

    for (const file of files) {
        try {
            await fs.promises.unlink(file.path);
            console.log(`Removed: ${file.name}`);
            filesRemoved++;
        } catch (error) {
            console.error(`Error removing ${file.name}:`, error.message);
            errors++;
        }
    }

    // Print summary
    console.log('\nCleanup Summary:');
    console.log(`Files removed: ${filesRemoved}`);
    if (errors > 0) {
        console.log(`Errors encountered: ${errors}`);
    }
};

/**
 * Main cleanup function with interactive confirmation
 */
const cleanup = async () => {
    try {
        const files = await findMatchingFiles();

        if (files.length === 0) {
            console.log('No matching files found to remove');
            process.exit(0);
        }

        console.log('\nThe following files will be permanently deleted:');
        files.forEach(file => console.log(`- ${file.name}`));

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question('\nPress Y or Enter to proceed, any other key to cancel: ', async (answer) => {
            rl.close();

            if (answer.toLowerCase() === 'y' || answer === '') {
                console.log('\nStarting cleanup...');
                await removeFiles(files);
            } else {
                console.log('Operation cancelled');
            }

            process.exit(0);
        });

        // Handle Escape key
        process.stdin.on('data', (data) => {
            if (data[0] === 0x1b) { // ESC key
                console.log('Operation cancelled');
                process.exit(0);
            }
        });

    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
};

// Start the cleanup process
cleanup();