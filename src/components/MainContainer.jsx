import DensityPlot from "./DensityPlot.jsx";
import modelParameters from '../data/cgm1-classifier.json';
import randomSamples from '../data/CGM-classifier-random-samples.json'
import {EBM} from "../ebm/ebm.js";
import {EBMLocal} from "../ebm/ebmLocal.js";
import {GAMCoach} from "../ebm/gamcoach.js";
import {useEffect, useRef, useState} from "react";
import {TempConstraintsContext} from "./Contexts.jsx";
import '../global.css'

const difficultyTextMap = {
    1: 'very-easy',
    2: 'easy',
    3: 'neutral',
    4: 'hard',
    5: 'very-hard',
    6: 'lock'
};
class Constraints {
    /** @type {Map<string, string>} A map from feature name to the difficulty
     * string (very easy, easy, neutral, hard, very hard, lock)
     */
    difficulties;

    /** @type {Map<string, number[]>} A map from feature name to the acceptable
     * range. For continuous features, the range is [min, max]; for categorical
     * features, the range is [level1, level2, ...] where each level is a number.
     */
    acceptableRanges;

    /** @type {string[]} */
    allFeatureNames = [];

    /** @type {string[]} */
    allFeatureDisplayNames = [];

    /** @type {string[]} */
    allFeatureTransforms = [];

    /** @type {object} */
    labelDecoder = {};

    hasNewConstraints = true;

    /** @type {number | null} */
    maxNumFeaturesToVary = 4;

    /**
     * Initialize the Constraints object. It might modify the modelParameters as some
     * features only allow increasing/decreasing features. The initializer would
     * create the acceptable range based on the curExample
     * @param {object} modelParameters
     * @param {object[]} curExample
     */
    constructor(modelParameters, curExample) {
        this.difficulties = new Map();
        this.acceptableRanges = new Map();
        this.labelDecoder = {};

        // Iterate through the features to search for pre-defined constraints
        modelParameters.features.forEach((f, i) => {
            // excluding interaction terms from the feature array
            if (f.type === 'continuous' || f.type === 'categorical') {
                this.allFeatureNames.push(f.name);
                this.allFeatureDisplayNames.push(f.description.displayName);
                this.allFeatureTransforms.push(f.config.usesTransform);

                if (f.type === 'categorical') {
                    const labelDecoder = {};

                    Object.entries(modelParameters.labelEncoder[f.name]).forEach(
                        ([level, levelName]) => {
                            labelDecoder[levelName] =
                                f.description.levelDescription[level].displayName;
                        }
                    );

                    this.labelDecoder[f.name] = labelDecoder;
                }

                if (f.config.difficulty !== 3) {
                    this.difficulties.set(f.name, difficultyTextMap[f.config.difficulty]);
                }

                if (f.config.acceptableRange !== null) {
                    this.acceptableRanges.set(f.name, f.config.acceptableRange);
                } else {
                    if (f.config.requiresIncreasing) {
                        // Impose acceptable range to be [cur value, max value]
                        const featureMax = f.binEdge[f.binEdge.length - 1];
                        f.config.acceptableRange = [curExample[i], featureMax];
                        this.acceptableRanges.set(f.name, f.config.acceptableRange);
                    } else if (f.config.requiresDecreasing) {
                        // Impose acceptable range to be [min value, cur value]
                        const featureMin = f.binEdge[0];
                        f.config.acceptableRange = [featureMin, curExample[i]];
                        this.acceptableRanges.set(f.name, f.config.acceptableRange);
                    }
                }
            }
        });
    }

    /**
     * Compute feature ranges for generating CF based on this.acceptableRanges
     */
    get featureRanges() {
        return Object.fromEntries(this.acceptableRanges);
    }

    // Factoring out this to avoid losing class context when calling the method during updates.
    /**
     * Compute feature weight multipliers for generating CF based on
     * this.difficulties
     */
    get featureWeightMultipliers() {
        const multipliers = {};

        const scoreMap = {
            'very-easy': 0.1,
            easy: 0.5,
            neutral: 1,
            hard: 2,
            'very-hard': 10
        };

        this.difficulties.forEach((v, k) => {
            if (v !== 'lock' && v !== 'neutral') {
                multipliers[k] = scoreMap[v];
            }
        });

        return multipliers;
    }

    // Factoring out this to avoid losing class context when calling the method during updates.
    /**
     * Compute available features to change for generating CF based on this.
     * difficulties (features that are set to be locked)
     */
    get featuresToVary() {
        const featureToVary = [];
        const featureDiffs = new Set(this.difficulties.values());

        if (featureDiffs.has('lock')) {
            this.allFeatureNames.forEach((d) => {
                if (!this.difficulties.has(d) || this.difficulties.get(d) !== 'lock') {
                    featureToVary.push(d);
                }
            });
            return featureToVary;
        } else {
            return null;
        }
    }

    /**
     * Return a clean serializable copy of the constraint object.
     */
    getCleanCopy() {
        return {
            difficulties: Array.from(this.difficulties.entries()),
            acceptableRanges: Array.from(this.acceptableRanges.entries()),
            allFeatureNames: this.allFeatureNames.slice(),
            maxNumFeaturesToVary: this.maxNumFeaturesToVary
        };
    }
}

// difficulties are Constraints.difficulties
function featureWeightMultipliers(difficulties) {
    const multipliers = {};

    const scoreMap = {
        'very easy': 0.1,
        'easy': 0.5,
        'neutral': 1,
        'hard': 2,
        'very hard': 10
    };

    difficulties.forEach((v, k) => {
        if (v !== 'lock' && v !== 'neutral') {
            multipliers[k] = scoreMap[v];
        }
    });

    return multipliers;
}
// difficulties, allFeatureNames,  are Constraints.difficulties etc
function featuresToVary(difficulties, allFeatureNames) {
    const featureToVary = [];
    const featureDiffs = new Set(difficulties.values());

    if (featureDiffs.has('lock')) {
        allFeatureNames.forEach((d) => {
            if (!difficulties.has(d) || difficulties.get(d) !== 'lock') {
                featureToVary.push(d);
            }
        });
        return featureToVary;
    } else {
        return null;
    }}

class Plan {
    /** @type{Feature[]} */
    features;

    /** @type{EBMLocal} */
    ebmLocal;

    /** @type{number} The raw score of the EBM output on the original sample */
    originalScore;

    /** @type{object[]} The sample generated by GAM Coach*/
    coachSample;

    /** @type{object[]} The initial sample */
    curExample;

    /** @type{number} */
    planIndex;

    /** adding the constraints for in which each plan is calculated */
    /** @type{Constraints} */
    planConstraints = null;

    /**
     * Initialize a Plan object
     * @param {object} modelParameters Loaded model data
     * @param {object[]} curExample Current sample values
     * @param {Plans} plans
     * @param {object[]} cfData The data of CFs returned from GAMCoach
     * @param {number} planIndex The index of this plan
     * @param {Constraints} planConstraints
     */
    constructor(modelParameters, curExample, plans, cfData, planIndex, planConstraints) {
        this.features = this.initFeatures(modelParameters, curExample, cfData);
        this.coachSample = cfData;
        this.curExample = curExample;
        this.planIndex = planIndex;
        this.planConstraints = planConstraints
        this.ebmLocal = new EBMLocal(modelParameters, cfData);
        this.originalScore = plans.originalScore;
    }

    /**
     * Initialize the features
     * @param modelParameters
     * @param curExample
     * @param cfData
     */
    initFeatures(modelParameters, curExample, cfData) {
        /** @type{Feature[]} */
        const features = [];

        // Convert categorical label to level ID
        const labelDecoder = {};
        Object.keys(modelParameters.labelEncoder).forEach((f) => {
            labelDecoder[f] = {};
            Object.keys(modelParameters.labelEncoder[f]).forEach((l) => {
                labelDecoder[f][modelParameters.labelEncoder[f][l]] = +l;
            });
        });

        for (let i = 0; i < modelParameters.features.length; i++) {
            const curType = modelParameters.features[i].type;

            if (curType !== 'interaction') {
                const config = modelParameters.features[i].config;

                /** @type {Feature} */
                const curFeature = {
                    data: modelParameters.features[i],
                    featureID: i,
                    isCont: true,
                    requiresInt: config.requiresInt,
                    labelEncoder: null,
                    originalValue: curExample[i],
                    coachValue: cfData[i],
                    myValue: cfData[i],
                    isChanged: cfData[i] === curExample[i] ? 0 : 1,
                    difficulty: difficultyTextMap[config.difficulty],
                    isConstrained: false,
                    acceptableRange: config.acceptableRange,
                    transform: config.usesTransform,
                    description: modelParameters.features[i].description
                };

                if (curType === 'categorical') {
                    curFeature.isCont = false;
                    curFeature.requiresInt = false;
                    curFeature.labelEncoder =
                        modelParameters.labelEncoder[modelParameters.features[i].name];

                    // Decode the category to number
                    curFeature.originalValue =
                        labelDecoder[modelParameters.features[i].name][curExample[i]];
                    curFeature.coachValue =
                        labelDecoder[modelParameters.features[i].name][cfData[i]];
                    curFeature.myValue =
                        labelDecoder[modelParameters.features[i].name][cfData[i]];
                }

                curFeature.isConstrained =
                    curFeature.difficulty !== 'neutral' ||
                    curFeature.acceptableRange !== null;

                features.push(curFeature);
            }
        }

        // Sort the features based on the importance
        features.sort((a, b) => b.data.importance - a.data.importance);

        return features;
    }

    /**
     * True if the current sample is changed by the user
     */
    get isChangedByUser() {
        // Compare the current sample with the saved coach sample
        let isChanged = false;
        this.ebmLocal.sample.forEach((d, i) => {
            if (this.coachSample[i] !== d) {
                isChanged = true;
                return isChanged;
            }
        });
        return isChanged;
    }

    /**
     * Create a cleaner copy (without features data) for the current plan
     */
    getCleanPlanCopy() {
        const planCopy = {};

        planCopy.ebmLocal = {
            pred: this.ebmLocal.pred,
            predScore: this.ebmLocal.predScore,
            predProb: this.ebmLocal.predProb,
            sample: this.ebmLocal.sample.slice()
        };

        planCopy.originalScore = this.originalScore;
        planCopy.coachSample = this.coachSample.slice();
        planCopy.curExample = this.curExample.slice();
        planCopy.planIndex = this.planIndex;

        return planCopy;
    }
}

// var 6, 7,
// DensityPlot3.jsx:70 Error: <rect> attribute width: A negative value is not valid. ("-129.281045751634")
// it seems that it will not impact the visualization also might be an error in the data...
// don't do anything for now

function PlanSelector({plans}) {
    const allAvailablePlans = [...plans.planStores]
    const allAvailableIndexes = Array.from(Array(allAvailablePlans.length).keys());
    const [selectedIndex, setSelectedIndex] = useState(allAvailableIndexes[0]);
    const selectedPlan = allAvailablePlans[selectedIndex][1];

    // In order to avoid doing logic in the rendering JSX
    // map with uuid as a key and plan index as value for radio buttons loop below
    const radioButtonData = new Map();
    allAvailableIndexes.forEach((id) => {
        const uuid = window.crypto.randomUUID();
        radioButtonData.set(uuid, String(id));
    })

    // creating an array with one data obj per feature in the plan
    // to be used as input for DensityPlot
    const densityPlotData = [];
    for (let featureIndex = 0; featureIndex < selectedPlan.features.length; featureIndex++) {

        const planFeatures = selectedPlan.features;
        const planConstraints = selectedPlan.planConstraints;
        const singlePlanFeature = planFeatures[featureIndex];
        const featureDisplayName = singlePlanFeature.data.description.displayName;
        const featureName = singlePlanFeature.data.name;
        const featureHistEdge = singlePlanFeature.data.histEdge;
        const featureHistCount = singlePlanFeature.data.histCount;
        const singleFeatureCurrentValue = singlePlanFeature.originalValue;  // current score
        const singleFeatureChangedValue = singlePlanFeature.coachValue;     // model updated score

        // can be undefined or {array[num, num]}
        const singleFeatureConstraints = planConstraints.acceptableRanges.get(featureName);

        const data = {
            featureName,
            featureDisplayName,
            currentValue: singleFeatureCurrentValue,
            changedValue: singleFeatureChangedValue,
            histEdge: featureHistEdge,
            histCount: featureHistCount,
            singleFeatureConstraints
        }

        densityPlotData.push(data);
    }

    return (
        <>
            {allAvailableIndexes.map((value, uuid) => {
                return (
                    <div key={`container-${uuid}`}>
                        <input type="radio" name="radio-button" id={`plan-${uuid}`} value={value}
                               onChange={(e) => {
                                   setSelectedIndex(Number(e.target.value))
                               }}
                               checked={selectedIndex === Number(value)}
                        />
                        <label htmlFor={`plan-${uuid}`}>Plan {value}</label>
                        <br/>
                    </div>
                )
            })}
            <div>Selected Plan Index: {selectedIndex}</div>
            <br />
            <div className="features">
                {densityPlotData.map((featureData) => <DensityPlot key={window.crypto.randomUUID()} data={featureData}></DensityPlot>)}
            </div>
        </>
    );
}

export default function MainContainer() {
    const curExample = randomSamples[0];
    // WHY THE FOLLOWING COMMENT? maybe some state management in the svelte version:
    // Creating the constraints object can change the modelParameters (setting
    // the acceptance range based on the curExample)
    const [constraints, setConstraints] = useState(new Constraints(modelParameters, curExample));
    const tempConstraints = useRef(new Constraints(modelParameters, curExample));
    const plans = useRef(null);
    const [arePlansLoaded, setArePlansLoaded] = useState(false);
    const model = new EBM(modelParameters);

    /**
     * Iteratively populate the plans.
     * @param {object} modelParameters The loaded model data
     * @param {EBM} model Initialized EBM model
     * @param {object[]} curExample The current sample data
     * @param {Constraints} constraints Global constraint configurations
     */
    useEffect(() => {
        const initializePlans = async function(modelParameters, model, curExample, constraints, plans) {

            const tempPlans = {
                isRegression: false,
                regressionName: 'default regression name',
                originalScore: 99.999,
                score: 99.999,
                classes: ['default rejection class', 'default approval class'],
                classTarget: [1],
                continuousIntegerFeatures: [],
                activePlanIndex: 1,
                nextPlanIndex: 1,
                planStores: new Map(),
                failedPlans: new Set()
            };
            if (modelParameters.isClassifier) {
                tempPlans.isRegression = false;
                tempPlans.classes = modelParameters.modelInfo.classes;
            } else {
                tempPlans.isRegression = true;
                tempPlans.regressionName = modelParameters.modelInfo.regressionName;
            }

            // true to initialize the original score, the log odds for binary classification
            // curExample should be one single example, i.e. one single sample, for witch to predict the
            // log odd. The output is a single value.
            // originalScore is intended as the score of the model without modifications
            tempPlans.originalScore = model.predict([curExample], true)[0];

            // Update the list of continuous features that require integer values
            modelParameters.features.forEach((f) => {
                // Need to be careful about the features that have both transforms and
                // integer requirement. For them, the integer transformation is only
                // applied visually
                if (
                    f.type === 'continuous' &&
                    f.config.usesTransform === null &&
                    f.config.requiresInt
                ) {
                    tempPlans.continuousIntegerFeatures.push(f.name);
                }
            });

            plans.current = tempPlans;

            /*
             * Generate the initial 5 plans. The one first, then the other 4 below.
             *  We can use topK = 5, but we will have to
             * wait for a long time. Instead, we progressively generate these top 5
             * plans.
             */
            const coach = new GAMCoach(modelParameters);
            const exampleBatch = [curExample];
            const singleFeatures = new Set();

            /*
            * What is in the cfs object that will tell the UI what variables needs to be changed and by how much?
            * the data property:
            * it should be the updated score for each variable, so if I take the differences in values between the curExample
            * and cfs.data, and if they are different, they should give the indication of what variable to change
            * (assuming that the variables are in the same order as the variables in the features names, which
            * verified that they are)
            */
            // cf or CF stands for counterfactuals
            let cfs = await coach.generateCfs({
                curExample: exampleBatch,
                totalCfs: 1, // this cfs is just for ONE PLAN.
                continuousIntegerFeatures: plans.current.continuousIntegerFeatures,
                featuresToVary: constraints.featuresToVary,
                featureRanges: constraints.featureRanges,
                featureWeightMultipliers: constraints.featureWeightMultipliers,
                targetRange: [plans.originalScore + 1, Infinity],  // Added for managing regressions task
                verbose: 0,
                maxNumFeaturesToVary: constraints.maxNumFeaturesToVary
            });

            // If the plan only uses one feature, we store it to a set and avoid future
            // plans that only uses that feature
            // WHY? maybe because another generation will propose the same feature with just a different value?
            if (cfs.isSuccessful && cfs.activeVariables[0].length === 1) {
                const curFeature = cfs.activeVariables[0][0].replace(/(.*):.*!/g, '$1');
                singleFeatures.add(curFeature);
            }

            let curPlan;

            if (cfs.isSuccessful) {
                curPlan = new Plan(
                    modelParameters,
                    curExample,
                    plans.current, // ? why do I do this?
                    // ?? for later: why don't pass just cfs.data[0]? cfs.isSuccessful will always be true if we are in the if statement
                    cfs.isSuccessful ? cfs.data[0] : curExample,
                    tempPlans.nextPlanIndex,
                    constraints
                );

                // Here I am still referring to the tempPlans instead of plans
                // just because tempPlans stores the nextPlanIndex
                plans.current.planStores.set(tempPlans.nextPlanIndex, curPlan);
            }

            // Handle failure case for the FIRST PLAN ONLY
            // worry about failure case only AFTER the state managing solution is implemented
            if (!cfs.isSuccessful) {
                // why am I using tempPlans instead of plans? again just because tempPlans stores the nextPlanIndex
                for (
                    let i = tempPlans.nextPlanIndex;
                    i < tempPlans.nextPlanIndex + 5;
                    i++
                ) {
                    plans.current.failedPlans.add(i);
                }

                // Handle the case where all plans failed
                window.alert(
                    'There is no strategy to change the AI decision under your current configuration. Relax some constraints and try to regenerate again.'
                );
                curPlan = new Plan(
                    modelParameters,
                    curExample,
                    plans.current,
                    cfs.isSuccessful ? cfs.data[0] : curExample,
                    tempPlans.nextPlanIndex,
                    constraints
                );
                plans.current.planStores.set(plans.current.activePlanIndex, curPlan);
                plans.current.nextPlanIndex += 5;
            }

            // Generate the next-optimal CF solutions.
            // generateSubCf should be called after the top-k CFs are generated by generateCfs(),
            // as it requires the options argument (cfs.nextCfConfig generated from generateCfs?)
            // NOTE in the comment above, there seems to be a contradiction:
            // above i've not generate the top-k solution! i'm splitting up the things so that I don't have
            // to do precisely that!
            const totalPlanNum = 5;

            // sub plans are generated every time?
            for (let i = 1; i < totalPlanNum; i++) {
                if (!cfs.isSuccessful) {
                    break;
                }

                // console.time(`Plan ${tempPlans.nextPlanIndex + i} generated`);
                cfs = await coach.generateSubCfs(cfs.nextCfConfig);
                // console.timeEnd(`Plan ${tempPlans.nextPlanIndex + i} generated`);

                // If the new plan uses only one feature, we mute it and repeat again
                if (cfs.isSuccessful && cfs.activeVariables[0].length === 1) {
                    const curFeature = cfs.activeVariables[0][0].replace(/(.*):.*!/g, '$1');
                    if (singleFeatures.has(curFeature)) {
                        i--;
                        continue;
                    } else {
                        singleFeatures.add(curFeature);
                    }
                }

                if (cfs.isSuccessful) {
                    curPlan = new Plan(
                        modelParameters,
                        curExample,
                        plans.current,
                        cfs.isSuccessful ? cfs.data[0] : curExample,
                        tempPlans.nextPlanIndex + i,
                        constraints
                    );
                    plans.current.planStores.set(tempPlans.nextPlanIndex + i, curPlan);
                }

                // Handle failure case
                if (!cfs.isSuccessful) {
                    for (
                        let j = tempPlans.nextPlanIndex + i;
                        j < tempPlans.nextPlanIndex + 5;
                        j++
                    ) {
                        plans.current.failedPlans.add(j);
                    }
                    break;
                }
            }

            plans.current.nextPlanIndex += 5;
            setArePlansLoaded(true);
        }

        const updatePlans = async function (constraints, modelParameters, curExample, plans) {
            /**
             * Handler for the regenerate button click event. This function regenerates
             * five new plans to replace the existing plans with the latest constraints
             * information.
             * @param {Constraints} constraints Global constraint configurations
             * @param {object} modelParameters The loaded model data
             * @param {object[]} curExample The current sample data
             * @param {Plans} plans The current plans
             * @param {(newPlans: Plans) => void} plansUpdated Workaround function to
             *  trigger an update on the plans variable
             * @param {Logger} [logger] Logger object
             */

            /**
             * To generate new plans, we need to complete the following steps:
             *
             * (1) Empty planStores
             * (2) Iteratively generate new plans and their stores
             * (3) Update the active plan index to the first tab when the first plan is
             *  updated => force an update on the feature panel
             * (4) Update the next plan index
             */

            // Seems to have no effect on the react implementation.
            // It is the only difference in the constraints obj in the first update
            // between the new and the old version
            constraints.hasNewConstraints = false;

            /*
            * Step 1:
            * Removing old plans mainly because, due to the fact of how state is drilled for
            * the difficulty changes, in old plan I see updated difficulties that are not in
            * sync with the constraints and plans at the moment of calculation.
            * */
            plans.planStores = new Map();

            // Step 2: Iteratively generate new plans with the new constraints
            const coach = new GAMCoach(modelParameters);
            const exampleBatch = [curExample];
            const singleFeatures = new Set();

            // AGAIN it generates only ONE PLAN FIRST, same code as initPlans()
            // console.time(`Plan ${plans.nextPlanIndex} generated`);
            let cfs = await coach.generateCfs({
                curExample: exampleBatch,
                totalCfs: 1,
                continuousIntegerFeatures: plans.continuousIntegerFeatures, // [] can be a default, copying default from svelte, original was plans.continuousIntegerFeatures,
                featuresToVary: featuresToVary(constraints.difficulties, constraints.allFeatureNames), // null can be a default. Copying default from svelte, original was constraints.featuresToVary, // seems to be about only difficulty management
                // getters seems to return null
                // featureRanges: constraints.featureRanges,
                // does not work though, the same plans are created.
                // Note that here the format is the same as the svelte version, is just that the debugger prints constraints.acceptableRanges instead of the Object
                featureRanges: Object.fromEntries(constraints.acceptableRanges),
                featureWeightMultipliers: featureWeightMultipliers(constraints.difficulties), // {} can be a default. Copying default from svelte, original was constraints.featureWeightMultipliers, // seems to be about only difficulty management
                targetRange: [plans.originalScore + 1, Infinity], // Added for managing regression.
                verbose: 0,
                maxNumFeaturesToVary: constraints.maxNumFeaturesToVary
            });
            // console.timeEnd(`Plan ${plans.nextPlanIndex} generated`);

            // If the plan only uses one feature, we store it to a set and avoid future
            // plans that only uses that feature
            if (cfs.activeVariables.length > 0 && cfs.activeVariables[0].length === 1) {
                const curFeature = cfs.activeVariables[0][0].replace(/(.*):.*/g, '$1');
                singleFeatures.add(curFeature);
            }

            // Step 3: Update the active plan index
            plans.activePlanIndex = plans.nextPlanIndex;

            let curPlan;

            if (cfs.isSuccessful) {
                curPlan = new Plan(
                    modelParameters,
                    curExample,
                    plans,
                    cfs.isSuccessful ? cfs.data[0] : curExample,
                    plans.nextPlanIndex,
                    constraints
                );

                plans.planStores.set(plans.nextPlanIndex, curPlan);
            }

            // Handle failure case
            if (!cfs.isSuccessful) {
                for (let j = plans.nextPlanIndex; j < plans.nextPlanIndex + 5; j++) {
                    plans.failedPlans.add(j);
                }

                // Handle the case where all 5 plans failed
                window.alert(
                    'There is no strategy to change the AI decision under your current configuration. Relax some constraints and try to regenerate again.'
                );
                curPlan = new Plan(
                    modelParameters,
                    curExample,
                    plans,
                    cfs.isSuccessful ? cfs.data[0] : curExample,
                    plans.activePlanIndex,
                    constraints
                );

                plans.planStores.set(plans.activePlanIndex, curPlan);
                plans.nextPlanIndex += 5;
            }

            // Generate other plans
            const totalPlanNum = 5;
            for (let i = 1; i < totalPlanNum; i++) {
                if (!cfs.isSuccessful) {
                    break;
                }

                // console.time(`Plan ${plans.nextPlanIndex + i} generated`);
                cfs = await coach.generateSubCfs(cfs.nextCfConfig);
                // console.timeEnd(`Plan ${plans.nextPlanIndex + i} generated`);

                // If the new plan uses only one feature, we mute it and repeat again
                if (cfs.isSuccessful && cfs.activeVariables[0].length === 1) {
                    const curFeature = cfs.activeVariables[0][0].replace(/(.*):.*/g, '$1');
                    if (singleFeatures.has(curFeature)) {
                        i--;
                        continue;
                    } else {
                        singleFeatures.add(curFeature);
                    }
                }

                if (cfs.isSuccessful) {
                    curPlan = new Plan(
                        modelParameters,
                        curExample,
                        plans,
                        cfs.isSuccessful ? cfs.data[0] : curExample,
                        plans.nextPlanIndex + i,
                        constraints
                    );
                    plans.planStores.set(plans.nextPlanIndex + i, curPlan);
                }

                // Handle failure case
                if (!cfs.isSuccessful) {
                    for (let j = plans.nextPlanIndex + i; j < plans.nextPlanIndex + 5; j++) {
                        plans.failedPlans.add(j);
                    }
                    break;
                }
            }

            plans.nextPlanIndex += 5;
            setArePlansLoaded(true);
        }

        // Since targetRange cannot be null when the model is a regressor,
        // I add it here. This will need to be refactored to take into account
        // both Regressors and Classifiers.
        if (constraints.acceptableRanges.size === 0 && constraints.difficulties.size === 0) {
            initializePlans(modelParameters, model, curExample, constraints, plans);
        } else {
            setArePlansLoaded(false); // Reset loading state
            updatePlans(constraints, modelParameters, curExample, plans.current)
                .then(() => setArePlansLoaded(true));
        }
    }, [constraints]);

    let plansDisplayElement = <div>Loading...</div>

    if (arePlansLoaded) {
        plansDisplayElement = <PlanSelector plans={plans.current}></PlanSelector>
    }

    // the indexes of the planStore map start at 0, even if inside every obj there is a key that starts from 1
    return (
        <TempConstraintsContext.Provider value={tempConstraints}>
            <button onClick={() => {
                setConstraints({...tempConstraints.current});
            }}>Regenerate Plans</button>
            <br></br>

            {plansDisplayElement}

        </TempConstraintsContext.Provider>
    )
}