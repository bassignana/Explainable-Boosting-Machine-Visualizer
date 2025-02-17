import {useRef, useEffect, useState, useContext} from 'react';
import * as d3 from 'd3';
import {TempConstraintsContext} from "./Contexts.jsx";
import '../global.css';

const DensityPlot = ({data}) => {
    const tempConstraints = useContext(TempConstraintsContext); // ref
    // console.log('temporary contraints in density plot', tempConstraints);
    // console.log('temp constraints left', tempConstraints.current.acceptableRanges.get(data.featureName)?.[0] || 'undefined');
    // console.log('temp constraints right', tempConstraints.current.acceptableRanges.get(data.featureName)?.[1] || 'undefined');
    // value={tempConstraints.current.acceptableRanges.get(data.featureName)?.[1] || rightRange}
    // ^ right intuition, but the current constraints have to come from the plan obj, the data obj, because
    // each density plot rage values are plan specific.
    // console.log('single feature constraints: ', data.singleFeatureConstraints);

    // @pattern: every time I need to create a react controlled component, do I need to create a state variable to
    // update its value every time?
    const [difficulty, setDifficulty] = useState(tempConstraints.current.difficulties?.get(data.featureName) ?? 'neutral');

    const [leftRange, setLeftRange] = useState( data.singleFeatureConstraints?.[0] ?? data.histEdge[0]);
    const [rightRange, setRightRange] = useState(data.singleFeatureConstraints?.[1] ?? data.histEdge[data.histEdge.length - 1]);
    // TODO: verify that useRef is for state that must not trigger a rerender
    // It's used for referencing html elements because if I need to keep a reference to the DOM
    // I need state otherwise I'll lose the reference on rerender. And I cannot use useState bc
    // I would cause a rerender on every dom update.
    const svgRef = useRef(null);

    useEffect(() => {
        if (!svgRef.current) return;

        const width = 500;
        const height = 180;
        // I need a margin so that the svg does not get cropped due to elements being plotted outside of the svg bounds
        const margin = { top: 30, right: 30, bottom: 30, left: 30 };

        const svg = d3.select(svgRef.current)
            .attr("width", width)
            .attr("height", height);

        // Prepare data
        const xValues = data.histEdge;
        const yValues = data.histCount;

        // Scales
        // Used for mapping pixel values to actual values.
        // The domain, the range of possible values of the thing that I want to plot
        // is reproportioned to the
        // range in pixel of the space that I want to plot into.
        // That is why domain is in unit of the variable and range is in pixel
        // Note that scale is not for ticks rendering, there is axis for that.
        const xScale = d3.scaleLinear()
            .domain([xValues[0], xValues[xValues.length - 1]])
            .range([margin.left, width - margin.right]);

        const yScale = d3.scaleLinear()
            .domain([0, Math.max(...yValues)])
            .range([height - margin.bottom, margin.top]);

        // Create line generator
        // d is defined below, when i use .datum in the svg.append("path")
        const curveLine = d3.line()
            .x(d => xScale(d[0]))
            .y(d => yScale(d[1]));

        // Create area generator
        const areaGenerator = d3.area()
            .x(d => xScale(d[0]))
            .y1(d => yScale(d[1]))
            .y0(yScale(0));

        // Create the full area
        svg.append("path")
            .datum(xValues.map((x, i) => [x, yValues[i]]))
            .attr("fill", "steelblue")
            .attr("opacity", 0.3)  // Make the fill semi-transparent
            .attr("d", areaGenerator);

        // clipPath definition
        svg.append("defs")
            .append("clipPath")
            .attr("id", `visible-area-${data.featureName}`) // Unique id, otherwise all plots are affected by a slider change.
            .append("rect")
            .attr("x", xScale(leftRange))
            .attr("y", margin.top)
            .attr("width", xScale(rightRange) - xScale(leftRange))
            .attr("height", height - margin.top - margin.bottom);

        // Create our visualization in two layers
        // Layer 1: Gray base (everything grayed out)
        const baseData = xValues.map((x, i) => [x, yValues[i]]);

        // Add the gray area
        svg.append("path")
            .datum(baseData)
            .attr("fill", "lightgray")
            .attr("opacity", 0.5)
            .attr("d", areaGenerator);

        // Add the gray line
        svg.append("path")
            .datum(baseData)
            .attr("fill", "none")
            .attr("stroke", "lightgray")
            .attr("stroke-width", 2)
            .attr("d", curveLine);

        // Layer 2: Colored portion (clipped to show only the selected range)
        // Create a group for our clipped content
        const coloredGroup = svg.append("g")
            .attr("clip-path", `url(#visible-area-${data.featureName})`); // Unique id, otherwise all plots are affected by a slider change.

        // Add the colored area within the clipped group
        coloredGroup.append("path")
            .datum(baseData)
            .attr("fill", "steelblue")
            .attr("opacity", 0.3)
            .attr("d", areaGenerator);

        // Add the colored line within the clipped group
        coloredGroup.append("path")
            .datum(baseData)
            .attr("fill", "none")
            .attr("stroke", "steelblue")
            .attr("stroke-width", 2)
            .attr("d", curveLine);

        // Add the axis X Axis
        // Note how I use groups tag to group different elements in svg to compose the chart
        svg.append("g")
            .attr("transform", `translate(0,${height - margin.bottom})`)
            .call(d3.axisBottom(xScale));

        // Clear any existing SVG content, otherwise every rerender is stacked upon the last one
        return () => d3.select(svgRef.current).selectAll("*").remove();

    }, [leftRange, rightRange, data]);

    const getCurrentOrChangedValueJSX = function () {
        if (data.currentValue !== data.changedValue) {
            return (
                <>
                    <span className="features-card-header-bottom-row-value">{data.currentValue}</span>
                    <div className="features-card-header-bottom-row-hypothesis">
                        <span>------&gt;</span>
                        <span className="features-card-header-bottom-row-hypothesis-change">{data.changedValue - data.currentValue}</span>
                    </div>
                    <span className="features-card-header-bottom-row-value" data-test="updated-value">{data.changedValue}</span>
                </>
            );
        } else {
            return (
                <>
                    <span className="value">{data.currentValue}</span>
                </>
            );
        }
    }

    return (
        <div className="features-card">
            <div className="features-card-header">
                <div className="features-card-header-top-row">
                    <span className="features-card-header-top-row-name">{data.featureDisplayName}</span>
                    <div>
                        <label htmlFor="difficulty-selector">Difficulty: </label>
                        <select id="difficulty-selector" value={difficulty}
                                onChange={(e) => {
                                    tempConstraints.current.difficulties.set(data.featureName, e.target.value);
                                    console.log(tempConstraints);
                                    setDifficulty(e.target.value)
                                }}>
                            <option value={'very easy'}>Very Easy</option>
                            <option value={'easy'}>Easy</option>
                            <option value={'neutral'}>Normal</option>
                            <option value={'hard'}>Hard</option>
                            <option value={'very hard'}>Very Hard</option>
                            <option value={'lock'}>Impossible</option>
                        </select>
                    </div>
                    {/*<span className="features-card-header-top-row-reset">ICON</span>*/}
                </div>
                <div className="features-card-header-bottom-row">
                    {getCurrentOrChangedValueJSX()}
                </div>
            </div>
            <div className="features-card-body">
                <svg ref={svgRef}></svg>
                <div className="features-card-body-sliders">
                    <div>Left Boundary</div>
                    <input
                        id="left-slider"
                        type="range"
                        min={data.histEdge[0]}
                        max={data.histEdge[data.histEdge.length - 1]}
                        step={(data.histEdge[data.histEdge.length - 1] - data.histEdge[0]) / 100}
                        value={leftRange}
                        onChange={(e) => {
                            const newLeft = Number(e.target.value);
                            if (newLeft < rightRange) {
                                // @dataFormat: acceptableRanges is a map, where the key is the variable name
                                // in the format of constraits.allFeaturesNames. es 'distance_last_high' and not
                                // 'Hyperglycemia lag (hours)' and the value is an array
                                // of numbers, as per JSdoc documentation [lower bound, upper bound]
                                //
                                // Update both the left and right to accomodate the current data format
                                // @verified: I update multiple plots at the same time.
                                tempConstraints.current.acceptableRanges.set(data.featureName, [newLeft, rightRange]);

                                // triggering the update after setting the temporary constraints
                                setLeftRange(newLeft)
                            };

                        }
                        }
                    />
                    <span>{leftRange.toFixed(2)}</span>

                    <div>Right Boundary</div>
                    <input
                        id="right-slider"
                        type="range"
                        min={data.histEdge[0]}
                        max={data.histEdge[data.histEdge.length - 1]}
                        step={(data.histEdge[data.histEdge.length - 1] - data.histEdge[0]) / 100}
                        value={rightRange}
                        onChange={(e) => {
                            const newRight = Number(e.target.value);
                            if (newRight > leftRange) {
                                tempConstraints.current.acceptableRanges.set(data.featureName, [leftRange, newRight]);
                                setRightRange(newRight);
                            }
                        }}
                    />
                    <span>{rightRange.toFixed(2)}</span>
                </div>
            </div>
        </div>

    );
};

export default DensityPlot;