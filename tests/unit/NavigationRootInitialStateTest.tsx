import {render} from '@testing-library/react-native';

import getAdaptedStateFromPath from '@libs/Navigation/helpers/getAdaptedStateFromPath';
import getPathFromState from '@libs/Navigation/helpers/getPathFromState';
import NavigationRoot from '@libs/Navigation/NavigationRoot';
import type {State} from '@libs/Navigation/types';

import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import type {Route} from '@src/ROUTES';
import ROUTES from '@src/ROUTES';

import type * as ReactNavigation from '@react-navigation/native';

import React from 'react';
import Onyx from 'react-native-onyx';

import waitForBatchedUpdates from '../utils/waitForBatchedUpdates';

// The `mock` prefix lets the hoisted jest.mock factory capture the initial state NavigationRoot computes.
let mockCapturedInitialState: State | undefined;

jest.mock('@react-navigation/native', () => {
    const actualNav = jest.requireActual<typeof ReactNavigation>('@react-navigation/native');
    return {
        ...actualNav,
        NavigationContainer: ({initialState}: {initialState?: State}) => {
            mockCapturedInitialState = initialState;
            return null;
        },
    };
});
jest.mock('@libs/Navigation/AppNavigator', () => () => null);
jest.mock('@libs/NavigationFocusReturn', () => ({setupNavigationFocusReturn: jest.fn(), teardownNavigationFocusReturn: jest.fn()}));
jest.mock('@src/libs/telemetry/useStartSpansOnRender', () => jest.fn());
jest.mock('@hooks/useTheme', () => () => ({appBG: '#000000', colorScheme: 'dark'}));
jest.mock('@hooks/useResponsiveLayout', () => () => ({shouldUseNarrowLayout: true}));

const DISTANCE_EDIT_ROUTE = ROUTES.MONEY_REQUEST_STEP_DISTANCE.getRoute(CONST.IOU.ACTION.EDIT, CONST.IOU.TYPE.SUBMIT, '1', '2');

describe('NavigationRoot initial state', () => {
    beforeAll(() => {
        Onyx.init({keys: ONYXKEYS});
    });

    beforeEach(async () => {
        mockCapturedInitialState = undefined;
        await Onyx.clear();
        await waitForBatchedUpdates();
    });

    it('restores the last visited path on a cold start for a public domain account', async () => {
        // Given a signed-in user with a public domain email (e.g. gmail.com) who had the distance editor open
        await Onyx.set(ONYXKEYS.ACCOUNT, {isFromPublicDomain: true});
        await waitForBatchedUpdates();

        // When the native app cold starts without a deep link, so there is no initial URL
        render(
            <NavigationRoot
                authenticated
                lastVisitedPath={DISTANCE_EDIT_ROUTE as Route}
                initialUrl={null}
                onReady={() => {}}
            />,
        );

        // Then the saved page is restored, because the email domain must not change which screen the user returns to
        if (!mockCapturedInitialState) {
            throw new Error('NavigationRoot did not restore an initial state');
        }
        expect(getPathFromState(mockCapturedInitialState)).toBe(getPathFromState(getAdaptedStateFromPath(DISTANCE_EDIT_ROUTE as Route)));
    });

    it('does not restore the last visited path when the user is signed out', async () => {
        // Given a public domain account whose session is no longer authenticated
        await Onyx.set(ONYXKEYS.ACCOUNT, {isFromPublicDomain: true});
        await waitForBatchedUpdates();

        // When the native app cold starts without a deep link
        render(
            <NavigationRoot
                authenticated={false}
                lastVisitedPath={DISTANCE_EDIT_ROUTE as Route}
                initialUrl={null}
                onReady={() => {}}
            />,
        );

        // Then React Navigation picks the initial state, so a signed-out user can't land on a protected page
        expect(mockCapturedInitialState).toBeUndefined();
    });

    it('sends a copilot who opens an onboarding link to Home', async () => {
        // Given a copilot acting for an account that has not finished onboarding
        await Onyx.set(ONYXKEYS.ACCOUNT, {delegatedAccess: {delegate: 'copilot@test.com'}});
        await Onyx.set(ONYXKEYS.NVP_ONBOARDING, {hasCompletedGuidedSetupFlow: false});
        await waitForBatchedUpdates();

        // When the app starts from an onboarding link
        render(
            <NavigationRoot
                authenticated
                lastVisitedPath={ROUTES.HOME}
                initialUrl={`${CONST.NEW_EXPENSIFY_URL}${ROUTES.ONBOARDING_PURPOSE.route}`}
                onReady={() => {}}
            />,
        );

        // Then the app opens Home, because the initial state never passes through OnboardingGuard
        if (!mockCapturedInitialState) {
            throw new Error('NavigationRoot did not set an initial state');
        }
        expect(getPathFromState(mockCapturedInitialState)).toBe(getPathFromState(getAdaptedStateFromPath(ROUTES.HOME)));
    });

    describe('abandoned onboarding step (#106926)', () => {
        // Why these live here: NavigationRoot's `useState` initializer runs once, synchronously, before
        // OpenApp/ReconnectApp answers, and a restored initial state never passes through OnboardingGuard
        // (the comment above the initializer, and the copilot case above, both say so). So no membership
        // check placed in this file can fix #106926 - the only correct behaviour is to not restore an
        // abandoned onboarding step at all. startOnboardingFlow resumes it from ONBOARDING_LAST_VISITED_PATH.
        const WORK_EMAIL_PATH = ROUTES.ONBOARDING_WORK_EMAIL.getRoute() as Route;
        const JOIN_WORKSPACE_TASK_PATH = ROUTES.ONBOARDING_WORK_EMAIL.getRoute(true) as Route;
        const NO_RESTORE = '/no-restore';

        it('does not restore an abandoned onboarding step when the root URL is reopened', async () => {
            // Given an account that abandoned onboarding on the public-domain work email step, and was
            // invited to someone else's workspace while the app was closed. The invite is not knowable
            // here: a reopen sends ReconnectApp, which does not refresh hasNonPersonalPolicy.
            await Onyx.set(ONYXKEYS.ACCOUNT, {isFromPublicDomain: true});
            await Onyx.set(ONYXKEYS.NVP_ONBOARDING, {hasCompletedGuidedSetupFlow: false});
            await waitForBatchedUpdates();

            // When the app is reopened at the bare root URL, so there is no specific deep link
            render(
                <NavigationRoot
                    authenticated
                    lastVisitedPath={WORK_EMAIL_PATH}
                    initialUrl={null}
                    onReady={() => {}}
                />,
            );

            // Then onboarding is not put into the initial state, because an initial state skips
            // OnboardingGuard and would strand an invited member in a flow they must not be in
            const restoredPath = mockCapturedInitialState ? getPathFromState(mockCapturedInitialState) : undefined;
            expect(restoredPath ?? NO_RESTORE).not.toContain(ROUTES.ONBOARDING_ROOT.route);
        });

        it('still restores a join-workspace task onboarding path', async () => {
            // Given the same unfinished onboarding, but the saved step is a join-workspace Concierge task
            // (isJoinWorkspaceTask=true), which is a task the user is meant to return to
            await Onyx.set(ONYXKEYS.ACCOUNT, {isFromPublicDomain: true});
            await Onyx.set(ONYXKEYS.NVP_ONBOARDING, {hasCompletedGuidedSetupFlow: false});
            await waitForBatchedUpdates();

            // When the app is reopened at the bare root URL
            render(
                <NavigationRoot
                    authenticated
                    lastVisitedPath={JOIN_WORKSPACE_TASK_PATH}
                    initialUrl={null}
                    onReady={() => {}}
                />,
            );

            // Then it is still restored, so the fix cannot pass by disabling restoration wholesale
            if (!mockCapturedInitialState) {
                throw new Error('NavigationRoot did not restore the join-workspace task path');
            }
            expect(getPathFromState(mockCapturedInitialState)).toBe(getPathFromState(getAdaptedStateFromPath(JOIN_WORKSPACE_TASK_PATH)));
        });

        it('still restores a non-onboarding path for an account that has not finished onboarding', async () => {
            // Given an account that has not finished onboarding but whose saved page is an ordinary screen
            await Onyx.set(ONYXKEYS.ACCOUNT, {isFromPublicDomain: true});
            await Onyx.set(ONYXKEYS.NVP_ONBOARDING, {hasCompletedGuidedSetupFlow: false});
            await waitForBatchedUpdates();

            // When the app is reopened at the bare root URL
            render(
                <NavigationRoot
                    authenticated
                    lastVisitedPath={DISTANCE_EDIT_ROUTE as Route}
                    initialUrl={null}
                    onReady={() => {}}
                />,
            );

            // Then it is restored, proving the skip is keyed on the saved path being an onboarding path
            // and not on onboarding merely being incomplete
            if (!mockCapturedInitialState) {
                throw new Error('NavigationRoot did not restore the last visited path');
            }
            expect(getPathFromState(mockCapturedInitialState)).toBe(getPathFromState(getAdaptedStateFromPath(DISTANCE_EDIT_ROUTE as Route)));
        });
    });
});
