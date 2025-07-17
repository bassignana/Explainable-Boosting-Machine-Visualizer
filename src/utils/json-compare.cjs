/**
 * Model Output Comparison Script
 * -----------------------------
 * Purpose: This script helps identify differences in model inputs/outputs between two different
 * project implementations that should theoretically produce the same results.
 *
 * Background:
 * - We have the same initial dataset being processed by the same model in two different projects
 * - The model is producing different results, and we need to identify where the differences occur
 * - Files are saved in the Downloads folder with the naming pattern:
 *   '{new|old}-initPlans-input-{object}.json'
 *   where 'new' represents one project and 'old' represents the other
 *
 * What this script does:
 * 1. Scans the Downloads folder for matching pairs of files
 * 2. Compares the content of each pair
 * 3. Reports which files have differences
 *
 * Usage:
 * > node compare-init-plans.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Compare two JSON objects deeply
 * @param {Object} obj1 First object
 * @param {Object} obj2 Second object
 * @returns {boolean} True if objects are equal
 */
const areObjectsEqual = (obj1, obj2) => {
    return JSON.stringify(obj1) === JSON.stringify(obj2);
};

/**
 * Get all matching files from downloads directory
 * @returns {Promise<Map<string, {new: string, old: string}>>} Map of object names to their file paths
 */
const getMatchingFiles = async () => {
    const downloadsPath = path.join(os.homedir(), 'Downloads');
    const files = await fs.promises.readdir(downloadsPath);

    // Regular expression to match the file pattern
    const filePattern = /^(new|old)-initPlans-input-(.+)\.json$/;

    // Group files by their object name
    const fileGroups = new Map();

    for (const file of files) {
        const match = file.match(filePattern);
        if (match) {
            const [, prefix, objectName] = match;
            const fullPath = path.join(downloadsPath, file);

            if (!fileGroups.has(objectName)) {
                fileGroups.set(objectName, {});
            }
            fileGroups.get(objectName)[prefix] = fullPath;
        }
    }

    // Only keep groups that have both new and old files
    return new Map([...fileGroups].filter(([, group]) => group.new && group.old));
};

/**
 * Compare files and report differences
 */
const compareFiles = async () => {
    try {
        const fileGroups = await getMatchingFiles();
        let differenceFound = false;

        for (const [objectName, paths] of fileGroups) {
            try {
                const oldContent = JSON.parse(await fs.promises.readFile(paths.old, 'utf8'));
                const newContent = JSON.parse(await fs.promises.readFile(paths.new, 'utf8'));

                if (!areObjectsEqual(oldContent, newContent)) {
                    differenceFound = true;
                    console.log(`\nDifferences found in files for object: ${objectName}`);
                    console.log(`Old file: ${path.basename(paths.old)}`);
                    console.log(`New file: ${path.basename(paths.new)}`);
                }
            } catch (error) {
                console.error(`Error comparing files for ${objectName}:`, error.message);
            }
        }

        if (!differenceFound) {
            console.log('\nNo different files found');
        }

        if (fileGroups.size === 0) {
            console.log('\nNo matching file pairs found in Downloads directory');
        }
    } catch (error) {
        console.error('Error accessing Downloads directory:', error.message);
    }
};

// Run the comparison
compareFiles();