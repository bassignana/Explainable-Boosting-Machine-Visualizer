import {useState, useContext, createContext} from "react";

/* Usage:
* Render this container in App.js
* Result:
* Changing the state in a state variable inside a context will
* change the value in everywhere, even in neested component.
* The other variables that have changed are PERSISTENT:
* all the state is saved between rerenders.
*
* Notice also that as soon as I change a state, a rerender is triggered. */

console.clear();
const defaultPlans = {
    plansStore: {
        0: 'plan 0',
        1: 'plan 1'
    }
};
const defaultConstraints = {
    value: 0
};
const GlobalContext = createContext();

function ChildStatic() {
    const [plans, setPlans, constraints, setConstraints] = useContext(GlobalContext);
    return (
        <>
            <div>{JSON.stringify(plans)}</div>
            <div>{JSON.stringify(constraints)}</div>
        </>
    );
}

function ChildDynamic() {
    const [plans, setPlans, constraints, setConstraints] = useContext(GlobalContext);

    return (
        <>
            <button onClick={() => setConstraints({value: Math.random()})}>change constraint</button>
            <div>{JSON.stringify(plans)}</div>
            <div>{JSON.stringify(constraints)}</div>
        </>
    );
}

function PlansUpdater() {
    const [plans, setPlans, constraints, setConstraints] = useContext(GlobalContext);

    return (
        <>
            <button onClick={() => setPlans({...plans, new: Math.random()})}>update plans</button>
            <div>{JSON.stringify(plans)}</div>
            <div>{JSON.stringify(constraints)}</div>
        </>
    );
}

export default function MainContainer() {
    const [constraints, setConstraints] = useState(defaultConstraints);
    const [plans, setPlans] = useState(defaultPlans);

    return (
        <>
        <GlobalContext.Provider value={[plans, setPlans, constraints, setConstraints]}>
            <ChildStatic/>
            <ChildDynamic/>
            <div>
                <ChildStatic></ChildStatic>
                <PlansUpdater></PlansUpdater>
            </div>
        </GlobalContext.Provider>
        </>
    )
}