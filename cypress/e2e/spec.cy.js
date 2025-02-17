// title is a description, a name for the test
// in the callback of describe there can be multiple test
// it is a single test, args are similar to describe fn
describe('template spec test', () => {
  it('initial visit', () => {
    // @solved: when running with browser, it fails, with webstorm runner, it passes:
    // I need to restart cypress and redo npx start cypress, bc I need to have the
    // web server already running when I start cypress
    cy.visit('http://localhost:5173/')
  });
  it('get uniquely the first slider', () => {

    // getting an element with cy.get(css selector)
    // in the gui there is a helper to find the right selector

    // Here I'm asking that the selected element(s) by get() are in total 1.
    // Note that i'm asking something about the selection, not the selected elements.
    // Note how I have to call visit again since it is a new test.

    // @pattern: better way to do the below
    // cy.visit('http://localhost:5173/').get(':nth-child(13) > .feature-plot > [value="1"]').should('have.length', 1)
    // cy.visit('http://localhost:5173/')
    // cy.get(':nth-child(13) > .feature-plot > [value="1"]').should('have.length', 1)
  });
  it('contains', () => {
    cy.visit('/')
    // I can also use regex inside contain to make the condition more flexible,
    // so I don't have a failing test if I change capitalization, for example.
    // cy.get('#root > :nth-child(1)').contains('The ui is rendering first')
    // Can also be cy.get('#root > :nth-child(1)').should('contains.text','The ui is rendering first')
  });

})

// See best practice: prefer longer tests over a series of very small test.
// list of user interactions: https://docs.cypress.io/api/table-of-contents#Actions

// assertion reference, lookup chai, sinon, jquery
// https://docs.cypress.io/app/references/assertions#__docusaurus_skipToContent_fallback
// pay attention to negative assertions and chained ones, see docs.

// ?:
// cypress yield, so don't use variables in test
// use .then(), a cypress specific command, not a promise,
// so cannot use async await in tests. If use the .then()
// use also a wrap(), see tutorial.

// @pattern: try to use unique data-test attr or id to select stuff,
// so if I change classes tests will not fail.

// See config for configuring baseUrl and use visit('/').
// Reload cypress after any config change.

