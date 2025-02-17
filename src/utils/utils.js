import d3 from './d3-import.js';

/**
 * Round a number to a given decimal.
 * @param {number} num Number to round
 * @param {number} decimal Decimal place
 * @returns number
 */
export const round = (num, decimal) => {
  return Math.round((num + Number.EPSILON) * (10 ** decimal)) / (10 ** decimal);
};

/**
 * Get a random number between [min, max], inclusive
 * @param {number} min Min value
 * @param {number} max Max value
 * @returns number
 */
export const random = (min, max) => {
  return Math.floor(Math.random() * (max - min)) + min;
};

/**
 * Pre-process the svg string to replace fill, stroke, color settings
 * @param {string} svgString
 * @param {string[]} resetColors A list of colors to reset to currentcolor
 * @returns {string}
 */
export const preProcessSVG = (svgString, resetColors=[]) => {
  let newString = svgString
    .replaceAll('black', 'currentcolor')
    .replaceAll('fill:none', 'fill:currentcolor')
    .replaceAll('stroke:none', 'fill:currentcolor');

  resetColors.forEach(c => {
    newString = newString.replaceAll(c, 'currentcolor');
  });

  return newString;
};

/**
 * Dynamically bind SVG files as inline SVG strings in this component
 * @param {HTMLElement} component Current component
 * @param {object[]} iconList A list of icon mappings (class => icon string)
 */
export const bindInlineSVG = (component, iconList) => {
  iconList.forEach((d) => {
    d3.select(component)
      .selectAll(`.svg-icon.${d.class}`)
      .each((_, i, g) => {
        const ele = d3.select(g[i]);
        let html = ele.html();
        html = html.concat(' ', preProcessSVG(d.svg));
        ele.html(html);
      });
  });
};

/**
 * Download a JSON file
 * @param {any} object
 * @param {HTMLElement | null} [dlAnchorElem]
 * @param {string} [fileName]
 */
export const downloadJSON = (
  object,
  dlAnchorElem = null,
  fileName = 'download.json'
) => {
  const dataStr =
    'data:text/json;charset=utf-8,' +
    encodeURIComponent(JSON.stringify(object));

  // Create dlAnchor if it is not given
  let myDlAnchorElem = dlAnchorElem;
  let needToRemoveAnchor = false;

  if (dlAnchorElem === null) {
    myDlAnchorElem = document.createElement('a');
    myDlAnchorElem.style.display = 'none';
    needToRemoveAnchor = true;
  }

  myDlAnchorElem.setAttribute('href', dataStr);
  myDlAnchorElem.setAttribute('download', `${fileName}`);
  myDlAnchorElem.click();

  if (needToRemoveAnchor) {
    myDlAnchorElem.remove();
  }
};

/**
 * Download a text file
 * @param {string} textString
 * @param {HTMLElement | null} [dlAnchorElem]
 * @param {string} [fileName]
 */
export const downloadText = (
  textString,
  dlAnchorElem,
  fileName = 'download.json'
) => {
  const dataStr =
    'data:text/plain;charset=utf-8,' + encodeURIComponent(textString);

  // Create dlAnchor if it is not given
  let myDlAnchorElem = dlAnchorElem;
  let needToRemoveAnchor = false;

  if (dlAnchorElem === null) {
    myDlAnchorElem = document.createElement('a');
    myDlAnchorElem.style.display = 'none';
    needToRemoveAnchor = true;
  }

  myDlAnchorElem.setAttribute('href', dataStr);
  myDlAnchorElem.setAttribute('download', `${fileName}`);
  myDlAnchorElem.click();

  if (needToRemoveAnchor) {
    myDlAnchorElem.remove();
  }
};

/**
 * Serializes a JavaScript object to a JSON file in the browser
 * @param {Object} obj - The object to serialize
 * @param {string} fileName - The desired file name
 * @returns {Promise<void>}
 */
// Example usage:
// import { serializeToJson } from './serializeToJson.js';
//
// const data = { name: 'test', values: [1, 2, 3] };
// await serializeToJson(data, 'test.json');
export const serializeToJson = async (obj, fileName) => {
  try {
    // Ensure the filename has .json extension
    const finalFileName = fileName.endsWith('.json')
        ? fileName
        : `${fileName}.json`;

    // Convert object to JSON string with proper formatting
    const jsonString = JSON.stringify(obj, null, 2);

    // Create a Blob containing the JSON data
    const blob = new Blob([jsonString], { type: 'application/json' });

    // Create a download link
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = finalFileName;

    // Trigger the download
    document.body.appendChild(link);
    link.click();

    // Clean up
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    console.log(`Successfully created JSON file: ${finalFileName}`);
  } catch (error) {
    console.error('Error serializing object:', error);
    throw error;
  }
};

