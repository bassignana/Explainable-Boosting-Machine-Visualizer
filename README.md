# Documentation

`npm run dev`

Per generare una variante dell'applicazione con nuovi dati basta,
al momento, caricare i due file prodotti dal progetto streamlit-ebm
nella cartella src/data e rinominarli correttamente.
I file di input non hanno bisogno di edit, per ora.

[] Verificare in qualche modo i risultati dei vari aggiornamenti.

# Old Documentation

## EBM (Explainable Boosting Machine) Implementation Notes

### Key Questions
- Where does the EBM function come into place?
- Previously assumed state would map to modelParameters.json file
- How does EBM(modelParameters) variable get used?
- In FeatureCard.svelte's initFeatureCard: appears to use JSON file layout, not EBM variable
- Source of `const featureInfo = feature.data`?

### Model Workflow

#### Initialization Process
1. `curExample` represents one sample:
   - Length equals number of model variables
   - Each number represents a variable value

#### Constraints Object Creation
For each variable:
1. Copies basic info:
   - name
   - description 
   - transformation

2. Feature handling:
   - **For categorical features:**
     - Creates labelDecoder based on modelParameter JSON's labelEncoder
   - **For difficulty levels:**
     - If difficulty ≠ 3 in modelParams: registers difficulty level internally

3. AcceptableRange handling:
   - If exists in modelParams: copies directly
   - If doesn't exist:
     - With requiresIncreasing flag: Range = [current value, max value]
     - With requiresDecreasing flag: Range = [min value, current value]
     - Otherwise: potentially remains null

#### Difficulty Mapping
- UI Difficulty Map:
  ```javascript
  const difficultyTextMap = {
      1: 'very-easy',
      2: 'easy',
      3: 'neutral',
      4: 'hard',
      5: 'very-hard',
      6: 'lock'
  };
  ```

- Algorithm Difficulty Map:
  ```javascript
  const scoreMap = {
      'very-easy': 0.1,
      'easy': 0.5,
      'neutral': 1,
      'hard': 2,
      'very-hard': 10
  };
  ```

### Model Object Analysis

#### Shared Properties between model obj and EBM:
- intercept
- binEdges
- featureTypes
- isClassifier
- interactionBinEdges (matches JSON binLabel1 and binLabel2)
- interactionIndexes (matches JSON feature[].id array)

#### Unique to EBM model:
- interactionScores
- scores array (contains additive field per feature)
- labelDecoder (while labelEncoder exists in both)

### Plans Implementation

#### tempPlans Modifications:
1. Switches isRegression
2. Updates regression/classes names
3. Assigns log odds for current sample via model.predict
4. Creates feature name list for:
   - continuous features
   - requestedInt: true
   - usesTransform: false
   
Note: Features with requestedInt:true AND usesTransform:true are skipped (Integer transform is visual only)

### GAMCoach Implementation









## How this model works?


1. **curExample** is one sample, with length = to the number of variables in the model, each number is a variable value.

2. creating the new **constraints** obj: (very misleading name)  
for each variable: 
- copies some basic info like name, description and transformation
- if a feature is categorical:
    creates its own labelDecoder based on the labelEncoder of the modelParameter json obj
- if the difficulty in the json modelParams !== 3
    it registers internally the level of difficulty
- if there is an already set acceptableRange in the modelParams json, it just copies it
    if there in NOT an accepptableRange:
    if there is the requiresIncreasing flag on the modelParams json file
       Impose acceptable range to be [cur value, max value]
    if there is the requiresDEcreasing flag on the modelParams json file
       Impose acceptable range to be [min value, curValue]
    else I think acceptableRange just stays null????
end for
>>>create a getter for the acceptablerange for each feature, I think that acceptRange
cannot be null, so should be either the full range or a potion, but never null,
especially if it is needed for painting
>>>create a getter for the feature difficulties, notice how unbalanced they are,
for now I keep them the same for testing pourposes. Basically they map the difficulty
map for the UI defined externally like
const difficultyTextMap = {
    1: 'very-easy',
    2: 'easy',
    3: 'neutral',
    4: 'hard',
    5: 'very-hard',
    6: 'lock'
};
to the internal difficulty map for the running of the actual algo, currently
const scoreMap = {
            'very-easy': 0.1,
            easy: 0.5,
            neutral: 1,
            hard: 2,
            'very-hard': 10
        };
>>>returns an array of, from what can i understand, all features available to be POTENTIALLY
varied, i.e. that are not locked. But check again // get featuresToVary()
>>>return a well formatted obj with difficulties (in terms of ui string values so very-easy', ...very-hard', lock),
acceptableranges, all feature names
and maxNumfeaturetovary. can be useful.
maxNumfeaturetovary is set here to be max at 4, and is not controlled by an arg
???? start ?????
since i've checked that on first run, all 3 of acceptablerange, requiresIn/DEcrease in json
model params file are null, i think in the first run, and also on the following ones,
 the acceptable range are still null for all
paramentesr that have not been changed by the user.
So it seems that the constraint obj is for internal use for modelling/calculation and cannot
be used for painitng
????? end ??????

model, ebm model. are the model obj and the the same or at least share the same values?
- intercept is the same
- binEDges are the same. NOTE that webStorm is counting array elemnents wrong in preview, they are
                         one less than what is displayed in the collapsed preview
- featureTypes are the same
- isClassifier is the same
- in ebm model obj, the interactionBinEdges are the same as the json binLabel1 and binLabel2
- in ebm model obj, the interactionIndexes are the same as the json id in feature[].id array
- in ebm model obj, the interactionScores SEEMS to be unique to the model
- in ebm model obj, the scores array contains the additive field for each feature
- there is a lableEncoder{} in both, but the labelDecoder is present only in the ebm model.
    It makes sense because I recreate the Decoder in the constraints also, BUT for examining
    the actual Encoder values I have to test a categorical feature that I don't have at my
    disposal right now.
> what is the meaning of these fields? look into model theory/python examples/ js model definition later.
For now, it seems that I need the model obj to calculate new scores, which should be output of some sort.
In fact, the model.predict it is used to create the log odds given the current example, meaning
given an array of values that my variables take and for that specific set of values, it will
output the log odds for a categorical yes/no output.
Note that for a single example, the score is a single number, which makes sense!
It can be a part of plotting the score for the plan, but the final score needs to be
between 0 adn 1.

tempPlans is just a placeholder to be modified, unknown why I have to initialize some values
and not keep null or undefined, maybe a svelte state management thing. They should be!
some modification are:
- switching isRegression,, regression/classes names
- assign the value for the log odds for the current sample via model.predict
- creates a list of feature names that are: continuus, requestedInt:true and usesTransform:false
    (if requestedInt:true and usesTransform:true the feature is skipped bc the Integer transform is
    only applied visually)
    BUT WHERE IS THIS USED?
at the end of these modifications, plans=tempPlans

const coach = new GAMCoach(modelParameters);
RADICALLY DIFFERENT OBJ
apart from contMads that is the same obj found in the modelParameter.json
the other 2 obj, ebm and ebmModel, are very different from the ebm model obj above
the ebm model contained here differs from the above ebm model because
- it has, in its features, all tha variables including the interaction effects ones: in particular
    the feature attribute is the same as the feature attr in the modelParameters.json
- it has a modelInfo and scoreRange taken from the modelParameters.json that the above ebm model does not have
NOTE: todo LATER, a full comparison between json, ebm, ebmLoca, ...
For now, in the EBMLocal class we get a prediction for one sample point,
BUT also we can MODIFY the feature values right in the class and get a new prediction.
ebm and ebm model seems to be only responsible for doing the modelling,
GAMCoach will calculate the actual linear programming solution.
Important question: Without knowing a lot about coach, is there all the things that I
need for plotting? If yes, i'm set.

*/


// NOTE: all this is part of an initPlans, but the regeneratePlans is almost identical.
// Constraint will probably be context and passed to any init or regenerate function
// same thing for the const model = new EBM(modelParameters);
// IN FACT I think that the only thing that change is the contraints. In the regeneratePlan
// they are the only thing that change, because the modelParameter.json is the same (? really?
// do I have to train another model with different constraints? anyway, it is a problem for later,
// now I need to be able to plot the initialized plans.
// Once I've done that I can then go and worry about state updates.)

// For plotting, I surely need two states: the constraints and the plans.


