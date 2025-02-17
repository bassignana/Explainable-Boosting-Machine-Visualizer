import DensityPlot from "./DensityPlot.jsx";
import modelParameters from '../data/cgm1-classifier.json';
import randomSamples from '../data/CGM-classifier-random-samples.json'
import {EBM} from "../ebm/ebm.js";
import {EBMLocal} from "../ebm/ebmLocal.js";
import {GAMCoach} from "../ebm/gamcoach.js";
import {useEffect, useRef, useState} from "react";
import {TempConstraintsContext} from "./Contexts.jsx";
import '../global.css'
import { serializeToJson } from '../utils/utils.js';
// const data = { name: 'test', values: [1, 2, 3] };
// // await serializeToJson(data, 'test.json');

// Now we have to implement:
// plan updates
// refactoring plan init and plan update into a context
// using the context effectively to make the app work


/*
* Main Component
*   Init constraint as state, will use for context.
*
*   TEST: is putting the conditional rendering of the plans here,
*   based on the fact that the async computation is finished or not,
*   a good idea?
*
*   For constraints: I need to keep track of every change in the constraints,
*   difficulty or range, but without causing any rerender, so I have to use
*   a Ref. Then on a button click, I need to update the constraints all at once
*   so just one rerender is done. By definition, the button will be outside the
*   individual plot component, so some form of drilling or context must be present.
*   I have to also manage the fact that on subsequent rerenders, i have to call the
*   updatePlans and not the initPlans: i might use an Effect with the constraints in
*   the dep array.
*   NOTE: I cannot simply reuse the initPlan maybe because i have to continue to
*   loop through optimal plans starting from the first?
* */
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
        // initializing plan constraints
        this.planConstraints = planConstraints

        // Initialize an EBM model associating with the plan
        // ?
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

    // for avoiding doing logic in the rendering JSX
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

        // @bug: the feature display array has the feature names in different order,
        // or something like that, so in the plots I have the wrong variables.
        // for now i'll just use the ugly name everywhere.
        // Or the name could be also be changed manually for changin feature names for
        // making them have more sense for a demo, but still there is some problems around
        // plot values
        const featureDisplayName = singlePlanFeature.data.description.displayName;


        const featureName = singlePlanFeature.data.name;
        // const featureDifficulty = singlePlanFeature.difficulty;
        // const featureIsChanged = singlePlanFeature.isChanged; // 0 or 1
        const featureHistEdge = singlePlanFeature.data.histEdge;
        const featureHistCount = singlePlanFeature.data.histCount;
        // const featureCurrentValue = selectedPlan.curExample;
        // const featureChangedValue = selectedPlan.coachSample;

        // @bug: trying to solve the bug above with new version of these
        // in case understand why it is wrong
        // const singleFeatureCurrentValue = featureCurrentValue[featureIndex];
        // const singleFeatureChangedValue = featureChangedValue[featureIndex];
        // see if it is myValue or originalValue, i think original since myValue is the blue thing
        const singleFeatureCurrentValue = singlePlanFeature.originalValue;
        const singleFeatureChangedValue = singlePlanFeature.coachValue;

        // can be undefined or {array[num, num]}
        const singleFeatureConstraints = planConstraints.acceptableRanges.get(featureName);

        const data = {
            featureName,
            featureDisplayName, // see @bug above.
            currentValue: singleFeatureCurrentValue,
            changedValue: singleFeatureChangedValue,
            histEdge: featureHistEdge,
            histCount: featureHistCount,
            singleFeatureConstraints
        }

        densityPlotData.push(data);
    }

    /*
    Changes made to the render the radio button selector:
    use div with a key
    ids needs to start with a letter, use pattern `plan-${uuid}`
    the name prop in input is what ties the radio button in one group
    added checked prop to manage appearences
    * */
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
    // console.log('Main Component global rerender');
    const curExample = randomSamples[0];
    // WHY THE FOLLOWING COMMENT? maybe some state management in the svelte version:
    // Creating the constraints object can change the modelParameters (setting
    // the acceptance range based on the curExample)
    const [constraints, setConstraints] = useState(new Constraints(modelParameters, curExample));
    const tempConstraints = useRef(new Constraints(modelParameters, curExample));
    const plans = useRef(null);
    const [arePlansLoaded, setArePlansLoaded] = useState(false);
    const model = new EBM(modelParameters);
    // notice how this is run AFTER the Effect.
    // Remove to see the logs in the async function.
    // console.clear();

    /**
     * Iteratively populate the plans.
     * @param {object} modelParameters The loaded model data
     * @param {EBM} model Initialized EBM model
     * @param {object[]} curExample The current sample data
     * @param {Constraints} constraints Global constraint configurations
     */
    useEffect(() => {
        const initializePlans = async function(modelParameters, model, curExample, constraints, plans) {
            // console.log('INIT: input', modelParameters, model, curExample, constraints);

            // moved initialization in state
            // let constraints = new Constraints(modelParameters, curExample);
            // await serializeToJson(modelParameters, 'new-initPlans-input-modelParameters.json');
            // await serializeToJson(model, 'new-initPlans-input-model.json');
            // await serializeToJson(curExample, 'new-initPlans-input-curExample.json');
            // await serializeToJson(constraints, 'new-initPlans-input-constraints.json');
            // // await serializeToJson(plans, 'new-initPlans-input-model.json');

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
            // console.log('Log odds scores, the output of model.predict(curExample)', tempPlans.originalScore);

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

            // Consume the new constraints
            // NOT USED IN THIS FILE, hasNewConstraints is true by default
            // probably use to start some action, probably a conditional update
            // constraints.hasNewConstraints = false;

            // removed const plans = tempPlans; in favor of updating the ref.
            // this should do the same as plansUpdated() below;
            plans.current = tempPlans;
            // await serializeToJson(plans.current, 'new-initPlans-input-tempPlans.json');

            // console.log('plans', plans);

            // plansUpdated(plans);
            // here probably the global context is updated with the newly created plans
            // which is reasonable since the initPlan function could be called anywhere
            // BUT, updating the context with only the tempPlans seems unnecessary,
            // maybe is done as a workaround to trigger something specific to svelte.

            /*
             * Generate the initial 5 plans. We can use topK = 5, but we will have to
             * wait for a long time. Instead, we progressively generate these top 5
             * plans.
             */
            const coach = new GAMCoach(modelParameters);
            // await serializeToJson(coach, 'new-initPlans-input-coach.json');
            // console.log('GAMCoach model:', coach)
            const exampleBatch = [curExample];
            const singleFeatures = new Set();

            /*
            * What is in the cfs object that will tell the UI what variables needs to be changed and by how much?
            * the data property:
            * it should be the updated score for each variable, so if I take the differences in values between the curExample
            * and cfs.data, and if they are different, they should give the indication of what variable to change
            * (assuming that the variables are in the same order as the variables in the features names, which i think they are)
            *
            * Can confirm also that they are ordered,
            * so I need to check my code for plotting and if the values are correct*/
            // console.time(`Plan ${tempPlans.nextPlanIndex} generated`);
            // cf or CF stands for counterfactuals
            // this cfs is just for ONE PLAN, I don't know what arg does that, maybe totalCfs
            let cfs = await coach.generateCfs({
                curExample: exampleBatch,
                totalCfs: 1,
                continuousIntegerFeatures: plans.current.continuousIntegerFeatures,
                featuresToVary: constraints.featuresToVary,
                featureRanges: constraints.featureRanges,
                featureWeightMultipliers: constraints.featureWeightMultipliers,
                verbose: 0,
                maxNumFeaturesToVary: constraints.maxNumFeaturesToVary
            });
            // await serializeToJson(cfs, `new-initPlans-input-cfs${tempPlans.nextPlanIndex}.json`);
            // console.timeEnd(`Plan ${tempPlans.nextPlanIndex} generated`);
            // console.log('cfs', cfs);

            // If the plan only uses one feature, we store it to a set and avoid future
            // plans that only uses that feature
            // WHY? maybe because another generation will propose the same feature with just a different value?
            if (cfs.isSuccessful && cfs.activeVariables[0].length === 1) {
                const curFeature = cfs.activeVariables[0][0].replace(/(.*):.*!/g, '$1');
                singleFeatures.add(curFeature);
            }

            let curPlan;
            // I don't use curPlanStore but still I get all my plans in the right obj
            // let curPlanStore;

            // WHY I'm generating here only ONE plan?
            if (cfs.isSuccessful) {
                // Convert the plan into a plan object
                curPlan = new Plan(
                    modelParameters,
                    curExample,
                    plans.current, // ? why do I do this?
                    // ?? for later: why don't pass just cfs.data[0]? cfs.isSuccessful will always be true if we are in the if statement
                    cfs.isSuccessful ? cfs.data[0] : curExample,
                    tempPlans.nextPlanIndex,
                    constraints
                );

                // Record the plan as a store and attach it to plans with the planIndex as a key
                // curPlanStore = writable(curPlan);

                // why am I still referring to the tempPlans instead of plans?
                // it is just because tempPlans stores the nextPlanIndex
                plans.current.planStores.set(tempPlans.nextPlanIndex, curPlan);

                // plansUpdated(plans);
                // maybe here i could call a context update?
                // console.log('first plan, SUCCESS', curPlan);
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
                    // plansUpdated(plans);
                    // here i should try the generation of a new plan with a different index????
                    // as stated in the sourct, the plansUpdated is a workaround function to trigger the update
                    // of the plans variable. Maybe that in the source was triggering the rerun of the init or update
                    // function.
                }

                // Handle the case where all plans failed
                window.alert(
                    'There is no strategy to change the AI decision under your current configuration. Relax some constraitns and try to regenerate again.'
                );
                curPlan = new Plan(
                    modelParameters,
                    curExample,
                    plans.current,
                    cfs.isSuccessful ? cfs.data[0] : curExample,
                    tempPlans.nextPlanIndex,
                    constraints
                );
                // console.log('FAILURE plans', curPlan);
                // curPlanStore = writable(curPlan);
                plans.current.planStores.set(plans.current.activePlanIndex, curPlan);

                plans.current.nextPlanIndex += 5;
                // plansUpdated(plans);
            }

            // Generate the next-optimal CF solutions.
            // generateSubCf should be called after the top-k CFs are generated by generateCfs(),
            // as it requires the options argument (cfs.nextCfConfig???) (generated from generateCfs()
            // NOTE in the comment above, there seems to be a contradiction:
            // above i've not generate the top-k solution! i'm splitting up the things so that I don't have
            // to do precisely that!
            const totalPlanNum = 5;

            // sub plans are generated every time?
            for (let i = 1; i < totalPlanNum; i++) {
                if (!cfs.isSuccessful) {
                    break;
                }

                // Run gam coach
                // console.time(`Plan ${tempPlans.nextPlanIndex + i} generated`);
                cfs = await coach.generateSubCfs(cfs.nextCfConfig);
                // await serializeToJson(cfs, `new-initPlans-input-cfsSecond${tempPlans.nextPlanIndex}.json`);
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
                    // Get the plan object
                    curPlan = new Plan(
                        modelParameters,
                        curExample,
                        plans.current,
                        cfs.isSuccessful ? cfs.data[0] : curExample,
                        tempPlans.nextPlanIndex + i,
                        constraints
                    );
                    // curPlanStore = writable(curPlan);
                    // console.log('second X plans', curPlan);
                    plans.current.planStores.set(tempPlans.nextPlanIndex + i, curPlan);
                    // plansUpdated(plans);
                }

                // Handle failure case
                if (!cfs.isSuccessful) {
                    for (
                        let j = tempPlans.nextPlanIndex + i;
                        j < tempPlans.nextPlanIndex + 5;
                        j++
                    ) {
                        plans.current.failedPlans.add(j);
                        // plansUpdated(plans);
                    }
                    break;
                }
            }

            // Update the next plan index
            plans.current.nextPlanIndex += 5;
            setArePlansLoaded(true);
            // console.log('INIT: plans at the end of init', plans);
            // plansUpdated(plans)

            // console.log('OBJ-state FOR PLOTTING: plans and constraints', plans, constraints);
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
            /*    export const regeneratePlans = async (
                    constraints,
                    modelParameters,
                    curExample,
                    plans,
                    plansUpdated,
                    logger = null
                ) => {*/
            /**
             * To generate new plans, we need to complete the following steps:
             *
             * (1) Empty planStores to make tabs start loading animation
             * (2) Iteratively generate new plans and their stores
             * (3) Update the active plan index to the first tab when the first plan is
             *  updated => force an update on the feature panel
             * (4) Update the next plan index
             */

            // Consume the new constraints
            // Seems to have no effect on the react implementation.
            // It is the only difference in the constraints obj in the first update
            // between the new and the old version
            constraints.hasNewConstraints = false;

            // Step 1: Empty planStores to make tabs start loading animation
            // @bug: If i emptly the plans here, then how the info are read from the
            //       plan obj below? Maybe triggering animation is a svelte thing
            // plans.planStores = new Map();
            // plansUpdated(plans)

            /*
            * Removing old plans mainly because, due to the fact of how state is drilled for
            * the difficulty changes, in old plan I see updated difficulties that are not in
            * sync with the constraints and plans at the moment of calculation.
            * */
            plans.planStores = new Map();

            // console.log('UPDATE FUNCTION constraints: inputs plans', constraints);

            // Step 2: Iteratively generate new plans with the new constraints
            const coach = new GAMCoach(modelParameters);
            const exampleBatch = [curExample];
            const singleFeatures = new Set();

            // AGAIN it generates only ONE PLAN FIRST, same code as initPlans()
            // await serializeToJson(coach, `new-initPlans-input-coach${plans.nextPlanIndex}.json`);
            // await serializeToJson(exampleBatch, `new-initPlans-input-exampleBatch${plans.nextPlanIndex}.json`);
            // await serializeToJson(plans.planStores, `new-initPlans-input-plansstores${plans.nextPlanIndex}.json`);
            // await serializeToJson(constraints, `new-initPlans-input-constraints${plans.nextPlanIndex}.json`);
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
            // console.log('plans.activePlanIndex', plans.activePlanIndex);
            // console.log('plans.nextPlanIndex', plans.nextPlanIndex);

            let curPlan;
            //let curPlanStore;

            if (cfs.isSuccessful) {
                // Convert the plan into a plan object
                curPlan = new Plan(
                    modelParameters,
                    curExample,
                    plans,
                    cfs.isSuccessful ? cfs.data[0] : curExample,
                    plans.nextPlanIndex,
                    constraints
                );

                // Record the plan as a store and attach it to plans with the planIndex as
                // a key
                //curPlanStore = writable(curPlan);
                plans.planStores.set(plans.nextPlanIndex, curPlan);
                //plansUpdated(plans);

            }

            // Handle failure case
            if (!cfs.isSuccessful) {
                for (let j = plans.nextPlanIndex; j < plans.nextPlanIndex + 5; j++) {
                    plans.failedPlans.add(j);
                    // plansUpdated(plans);
                }

                // Handle the case where all 5 plans failed
                window.alert(
                    'There is no strategy to change the AI decision under your current configuration. Relax some constraitns and try to regenerate again.'
                );
                curPlan = new Plan(
                    modelParameters,
                    curExample,
                    plans,
                    cfs.isSuccessful ? cfs.data[0] : curExample,
                    plans.activePlanIndex,
                    constraints
                );

                // curPlanStore = writable(curPlan);
                plans.planStores.set(plans.activePlanIndex, curPlan);

                plans.nextPlanIndex += 5;
                // plansUpdated(plans);
                // return; FIX: I will need this return in initPlans() also?
            }

            // Generate other plans
            const totalPlanNum = 5;
            for (let i = 1; i < totalPlanNum; i++) {
                if (!cfs.isSuccessful) {
                    break;
                }

                // Run gam coach
                console.time(`Plan ${plans.nextPlanIndex + i} generated`);
                cfs = await coach.generateSubCfs(cfs.nextCfConfig);
                // await serializeToJson(cfs, `new-initPlans-input-cfsUpdate${plans.nextPlanIndex}.json`);
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
                    // Get the plan object
                    curPlan = new Plan(
                        modelParameters,
                        curExample,
                        plans,
                        cfs.isSuccessful ? cfs.data[0] : curExample,
                        plans.nextPlanIndex + i,
                        constraints
                    );

                    // curPlanStore = writable(curPlan);
                    plans.planStores.set(plans.nextPlanIndex + i, curPlan);
                    // plansUpdated(plans);

                }

                // Handle failure case
                if (!cfs.isSuccessful) {
                    for (let j = plans.nextPlanIndex + i; j < plans.nextPlanIndex + 5; j++) {
                        plans.failedPlans.add(j);
                        // plansUpdated(plans);
                    }
                    break;
                }
            }

            // Update the next plan index
            plans.nextPlanIndex += 5;
            // plansUpdated(plans);
            setArePlansLoaded(true);
            // console.log('Update function, END Plans', plans);
        }

        if (constraints.acceptableRanges.size === 0 && constraints.difficulties.size === 0) {
            // console.log('Calling initializePlans');
            initializePlans(modelParameters, model, curExample, constraints, plans);
        } else {
            setArePlansLoaded(false); // Reset loading state
            updatePlans(constraints, modelParameters, curExample, plans.current)
                .then(() => setArePlansLoaded(true));
        }

    }, [constraints]);

    let plansDisplayElement = <div>Loading...</div>
    // console.log('are plans loaded var', arePlansLoaded);
    if (arePlansLoaded) {
        plansDisplayElement = <PlanSelector plans={plans.current}></PlanSelector>
    }

    // the indexes of the planStore map start at 0, even if inside every obj there is a key that starts from 1
    // const plansIndexes = Array.from(Array([...plans.current.planStores].length).keys());
    return (
        <TempConstraintsContext.Provider value={tempConstraints}>
            {/*<div>The ui is rendering first, while the async stuff is executing. As expected</div>*/}
            {/*<button onClick={() => console.log(plans)}>Log current plans</button>
            <button onClick={() => console.log(Array.from(Array([...plans.current.planStores].length).keys()))}>Log plans indexes</button>*/}
            <button onClick={() => {
                // console.log('tempConstraints.current: ', tempConstraints.current);
                setConstraints({...tempConstraints.current});
            }}>Regenerate Plans</button>
            <br></br>
            {/*// var 8 onward I have error: data.histEdge[0] is undefined*/}
            {/*// bc they are interaction effects. For now I don't show them to not confuse the user.*/}
            {/*{modelParameters.features.filter((f) => f.type !== 'interaction').map((f) => <DensityPlot3 data={f} key={f.name}/>)}*/}

            {/*I want to pass as little state as possible: plans and constraints. Can I use just that?*/}
            {/*The minimal state that I can pass is [...plans.planStores][planIndex][1] ?
            No, because I have to select a specific feature to be plotted, so I either create
            a component to do that, or I loop here or In the OuterLoopDisplay, which might be better*/}
            {/*<DensityPlot3 data={[...plans.planStores][0][1]}/>*/}

            {plansDisplayElement}

        </TempConstraintsContext.Provider>
    )
}