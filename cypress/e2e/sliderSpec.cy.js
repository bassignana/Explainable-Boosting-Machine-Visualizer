describe('current value inside range', () => {
    // runs this before every it() block, i.e. before every test.
    beforeEach(() => {
        cy.visit('/');

        // get() yields, so I HAVE to chain.
        // Yields possibly multiple elements!
        // ?: the should chainer, be.visible, is tested against all elements?
        cy.get('input[type=radio]').should('be.visible');
    })

    it('initial render values inside range', () => {
        // First, let's get all plan radio buttons
        cy.get('input[type="radio"]').then($radioButtons => {
            // For each radio button (plan)
            $radioButtons.each((index, radioButton) => {
                // Click the radio button to select the plan
                cy.wrap(radioButton).click()

                // For each feature in the current plan
                /*cy.get('.feature-container').each(($feature) => {
                        cy.wrap($feature).should("be.visible");

                        // this just will get any selector in the page, not the child that I want.
                        // cy.wrap($feature).get('[data-test="updated-value"]');
                })*/

                // When there are multiple values yealded by get, a JQuery obj is yealded with multiple results inside of it.
                // For the console logs I have to open the browser in cypress studio.
                // cy.get('.feature-container').then(($containers) => {
                        // console.log('Container', $container);

                    // @bug: seems that, against the documentation, there is no $array and the first arg to the callback is
                    // the index and the second is the htmlElement.
                    // But also this could be an antipatter, to use each on a result of a then.
                    // $containers.each(($value, index, $array) => {console.log($value, index, $array)})
                 //   })

                // Again, this selects all updated-values at the same time,
                // so the length it is equal to the number of updated values present in the whole plan.
                /*cy.get('.feature-container').find('[data-test="updated-value"]').its('length').then((length) => {
                    if (length === 0) {
                        console.log('element not present');
                    }
                })*/
                cy.get('.feature-container').each(($container) => {
                    // Theory: if i wrap, i use the cypress functions, if I don't, I'll use JQuery functions.

                    // Note that cy.wrap($container) will pass 'any' to find and not a specific subject
                    // Note that I'll have errors like:
                    // $container.find is not a function
                    // container.find is not a function
                    // if I mix jQ find with cypress commands like its()

                    // Checking that there is an updated value in the feature container.
                    // Note: can use variables with jQ.
                    const el = $container.find('[data-test="updated-value"]')
                    if (el.length !== 0) {
                        // jQ: have to use .text() and not .val() here.
                        // console.log(el.text());

                        // Wrapping the jQ element to be able to use cypress commands
                        cy.wrap($container).find('#left-slider').invoke('val').then(leftValue => {
                            cy.wrap($container).find('#right-slider').invoke('val').then(rightValue => {
                                // Convert to numbers for comparison
                                const leftBound = Number(leftValue)
                                const rightBound = Number(rightValue)
                                const updatedValue = Number(el.text())

                                expect(updatedValue).to.be.at.least(leftBound)
                                expect(updatedValue).to.be.at.most(rightBound)
                            })
                        })
                    }
                })
            })
        })
    });

    it('plan regeneration values inside range', () => {


        /* Setting the value of slider this way does not trigger the
        onChange event in react, so d3 does not updates the charts.
        ?: Do the important state variables get updated?
        cy.get('.feature-container').first().within(() => {
            cy.get('#left-slider').then($slider => {
                const min = Number($slider.attr('min'))
                const max = Number($slider.attr('max'))
                const middleValue = (min + max) / 2

                cy.wrap($slider).invoke('val', middleValue).trigger('change')
            })
        })*/

        // Get only the first feature and adjust its slider
        cy.get('.feature-container').first().within(() => {
            cy.get('#left-slider')
                .as('slider')  // Alias for easier reference
                .then($slider => {
                    const min = Number($slider.attr('min'))
                    const max = Number($slider.attr('max'))
                    const middleValue = (min + max) / 2

                    // Focus the slider first
                    cy.get('@slider').focus()

                    // HACK:
                    // In order to register UI updates from d3 we have to set the value
                    // two times!
                    cy.get('@slider')
                        .invoke('val', middleValue-1)
                        .trigger('change', { force: true })
                        .invoke('val', middleValue)
                        .trigger('change', { force: true })
                })
        })

        cy.contains('Regenerate Plans').click();

        // As above, check that the updated values are in range.
        cy.get('input[type="radio"]').then($radioButtons => {
            $radioButtons.each((index, radioButton) => {
                cy.wrap(radioButton).click()
                cy.get('.feature-container').each(($container) => {
                    const el = $container.find('[data-test="updated-value"]')
                    if (el.length !== 0) {
                        cy.wrap($container).find('#left-slider').invoke('val').then(leftValue => {
                            cy.wrap($container).find('#right-slider').invoke('val').then(rightValue => {
                                const leftBound = Number(leftValue)
                                const rightBound = Number(rightValue)
                                const updatedValue = Number(el.text())

                                expect(updatedValue).to.be.at.least(leftBound)
                                expect(updatedValue).to.be.at.most(rightBound)
                            })
                        })
                    }
                })
            })
        })
    });
});