import AccountUtils from '@libs/AccountUtils';
import {isServerDataReady, setOnboardingErrorMessage} from '@libs/actions/Welcome';
import Log from '@libs/Log';
import {isOnboardingFlowName} from '@libs/Navigation/helpers/isNavigatorName';
import {getDeepestFocusedScreen, isTwoFactorSetupScreen} from '@libs/Navigation/Navigation';

import {getOnboardingInitialPath} from '@userActions/Welcome/OnboardingFlow';

import CONFIG from '@src/CONFIG';
import CONST from '@src/CONST';
import NAVIGATORS from '@src/NAVIGATORS';
import ONYXKEYS from '@src/ONYXKEYS';
import type {Route} from '@src/ROUTES';
import ROUTES from '@src/ROUTES';
import SCREENS from '@src/SCREENS';
import type {Account, Onboarding, Policy} from '@src/types/onyx';

import type {NavigationAction, NavigationState} from '@react-navigation/native';
import type {OnyxCollection, OnyxEntry} from 'react-native-onyx';
import type {ValueOf} from 'type-fest';

import {findFocusedRoute} from '@react-navigation/native';
import {isActingAsDelegateSelector} from '@selectors/Account';
import {isSingleNewDotEntrySelector} from '@selectors/HybridApp';
import {createIsInvitedPolicyMemberSelector} from '@selectors/Policy';
import {hasCompletedGuidedSetupFlowSelector, tryNewDotOnyxSelector, wasInvitedToNewDotSelector} from '@selectors/Onboarding';
import Onyx from 'react-native-onyx';

import type {GuardResult, NavigationGuard} from './types';

type OnboardingCompanySize = ValueOf<typeof CONST.ONBOARDING_COMPANY_SIZE>;
type OnboardingPurpose = ValueOf<typeof CONST.ONBOARDING_CHOICES>;

const JOIN_WORKSPACE_TASK_SCREENS = new Set<string>([SCREENS.ONBOARDING.WORK_EMAIL, SCREENS.ONBOARDING.WORK_EMAIL_VALIDATION, SCREENS.ONBOARDING.WORKSPACES]);

/**
 * Module-level Onyx subscriptions for OnboardingGuard
 * These provide synchronous access to onboarding-related data
 */
let onboarding: OnyxEntry<Onboarding>;
let account: OnyxEntry<Account>;
let tryNewDot: {isHybridAppOnboardingCompleted: boolean | undefined; hasBeenAddedToNudgeMigration: boolean} | undefined;
let hybridApp: {isSingleNewDotEntry?: boolean} | undefined;
let onboardingPurposeSelected: OnyxEntry<OnboardingPurpose>;
let onboardingCompanySize: OnyxEntry<OnboardingCompanySize>;
let onboardingInitialPath: OnyxEntry<string>;
let hasNonPersonalPolicy: OnyxEntry<boolean>;
let wasInvitedToNewDot: boolean | undefined;
let hasLoadedApp: OnyxEntry<boolean>;
let onboardingPolicyID: OnyxEntry<string>;
let policies: OnyxCollection<Policy>;
let currentUserAccountID: number | undefined;
let isOffline = false;

Onyx.connectWithoutView({
    key: ONYXKEYS.NVP_ONBOARDING,
    callback: (value) => {
        onboarding = value;
    },
});

Onyx.connectWithoutView({
    key: ONYXKEYS.ACCOUNT,
    callback: (value) => {
        account = value;
    },
});

Onyx.connectWithoutView({
    key: ONYXKEYS.NVP_TRY_NEW_DOT,
    callback: (value) => {
        tryNewDot = value ? tryNewDotOnyxSelector(value) : undefined;
    },
});

Onyx.connectWithoutView({
    key: ONYXKEYS.HYBRID_APP,
    callback: (value) => {
        hybridApp = {isSingleNewDotEntry: value ? isSingleNewDotEntrySelector(value) : undefined};
    },
});

Onyx.connectWithoutView({
    key: ONYXKEYS.ONBOARDING_PURPOSE_SELECTED,
    callback: (value) => {
        onboardingPurposeSelected = value;
    },
});

Onyx.connectWithoutView({
    key: ONYXKEYS.ONBOARDING_COMPANY_SIZE,
    callback: (value) => {
        onboardingCompanySize = value;
    },
});

Onyx.connectWithoutView({
    key: ONYXKEYS.ONBOARDING_LAST_VISITED_PATH,
    callback: (value) => {
        onboardingInitialPath = value;
    },
});

Onyx.connectWithoutView({
    key: ONYXKEYS.HAS_NON_PERSONAL_POLICY,
    callback: (value) => {
        hasNonPersonalPolicy = value;
    },
});

Onyx.connectWithoutView({
    key: ONYXKEYS.NVP_INTRO_SELECTED,
    callback: (value) => {
        wasInvitedToNewDot = value ? wasInvitedToNewDotSelector(value) : undefined;
    },
});

// HAS_LOADED_APP is what separates a returning session (ReconnectApp) from a first run (OpenApp).
// Only the former needs the readiness wait below; on a first run the optimistic IS_LOADING_APP
// already covers it, and waiting there would change first-run behaviour for no reason.
Onyx.connectWithoutView({
    key: ONYXKEYS.HAS_LOADED_APP,
    callback: (value) => {
        hasLoadedApp = value;
    },
});

Onyx.connectWithoutView({
    key: ONYXKEYS.ONBOARDING_POLICY_ID,
    callback: (value) => {
        onboardingPolicyID = value;
    },
});

Onyx.connectWithoutView({
    key: ONYXKEYS.COLLECTION.POLICY,
    waitForCollectionCallback: true,
    callback: (value) => {
        policies = value;
    },
});

Onyx.connectWithoutView({
    key: ONYXKEYS.SESSION,
    callback: (value) => {
        currentUserAccountID = value?.accountID;
    },
});

// Read as a latched value rather than instantaneously: a single render reporting offline - a flap on
// mobile, or NetworkState before NetInfo reports - would otherwise skip the wait and decide from
// stale cache, with nothing able to retract it afterwards.
Onyx.connectWithoutView({
    key: ONYXKEYS.NETWORK,
    callback: (value) => {
        isOffline = value?.isOffline ?? false;
    },
});

/**
 * Helper to get the correct onboarding route based on current progress
 */
function getOnboardingRoute(): Route {
    return getOnboardingInitialPath({
        onboardingValuesParam: onboarding,
        isUserFromPublicDomain: !!account?.isFromPublicDomain,
        hasAccessiblePolicies: !!account?.hasAccessibleDomainPolicies,
        currentOnboardingCompanySize: onboardingCompanySize,
        currentOnboardingPurposeSelected: onboardingPurposeSelected,
        onboardingInitialPath,
        onboardingValues: onboarding,
        isAccountValidated: !!account?.validated,
    }) as Route;
}

function isRequiredTwoFactorSetupExceptionActive(): boolean {
    const hasCompletedGuidedSetupFlow = hasCompletedGuidedSetupFlowSelector(onboarding) ?? false;
    // Allow 2FA setup while the blocking overlay is up, and also through the post-verify
    // handoff window when the overlay is intentionally hidden but setup is still in progress.
    return AccountUtils.shouldShowRequire2FAPage(account, hasCompletedGuidedSetupFlow) || AccountUtils.isForced2FAOnboardingSetup(account, hasCompletedGuidedSetupFlow);
}

type DeepestFocusedScreenInput = NonNullable<Parameters<typeof getDeepestFocusedScreen>[0]>;

function isObjectPayload(value: unknown): value is DeepestFocusedScreenInput {
    return typeof value === 'object' && value !== null;
}

function getActionPayloadScreenName(action: NavigationAction): string | undefined {
    // NAVIGATE/PUSH payloads aren't full NavigationStates. getDeepestFocusedScreen accepts that shape.
    // Use a type guard (not `as`) so we stay within this file's no-unsafe-type-assertion seatbelt.
    if (!isObjectPayload(action.payload)) {
        return undefined;
    }

    return getDeepestFocusedScreen(action.payload)?.name;
}

function getActionPayloadScreenParams(action: NavigationAction): Record<string, unknown> | undefined {
    if (!isObjectPayload(action.payload)) {
        return undefined;
    }

    return getDeepestFocusedScreen(action.payload)?.params;
}

function isCurrentlyOnTwoFactorSetupRoute(state: NavigationState): boolean {
    return isTwoFactorSetupScreen(getDeepestFocusedScreen(state)?.name);
}

function shouldPreventReset(state: NavigationState, action: NavigationAction) {
    // Browser back that pops the last history entry dispatches GO_BACK instead of RESET, and it reaches the root only when it would leave onboarding
    const isGoBack = action.type === CONST.NAVIGATION.ACTION_TYPE.GO_BACK;
    if (!isGoBack && (action.type !== CONST.NAVIGATION_ACTIONS.RESET || !action?.payload)) {
        return false;
    }

    const currentFocusedRoute = findFocusedRoute(state);
    const targetFocusedRoute = findFocusedRoute(action?.payload as NavigationState);
    const isOnboardingCompleted = hasCompletedGuidedSetupFlowSelector(onboarding) ?? false;

    // Allow required 2FA setup navigation even when the user is currently on onboarding.
    if (isRequiredTwoFactorSetupExceptionActive() && isTwoFactorSetupScreen(getActionPayloadScreenName(action))) {
        return false;
    }

    // We want to prevent the user from navigating back to a non-onboarding screen if they are currently on an onboarding screen
    if (!isOnboardingCompleted && isOnboardingFlowName(currentFocusedRoute?.name) && !isOnboardingFlowName(targetFocusedRoute?.name)) {
        setOnboardingErrorMessage('onboarding.purpose.errorBackButton');
        return true;
    }

    return false;
}

function getActionTargetName(action: NavigationAction): string | undefined {
    return (action.payload as {name?: string} | undefined)?.name;
}

/**
 * Checks whether a route belongs to onboarding
 */
function isOnboardingTargetName(name: string | undefined): boolean {
    return name === NAVIGATORS.ONBOARDING_MODAL_NAVIGATOR || isOnboardingFlowName(name);
}

/**
 * Check if the navigation action is targeting an onboarding screen.
 * This handles RESET actions, and NAVIGATE/PUSH actions that target the OnboardingModalNavigator or one of its screens.
 */
function isNavigatingToOnboardingFlow(action: NavigationAction): boolean {
    if (action.type === CONST.NAVIGATION_ACTIONS.RESET && isObjectPayload(action.payload)) {
        return isOnboardingTargetName(getActionPayloadScreenName(action));
    }

    if ((action.type === CONST.NAVIGATION.ACTION_TYPE.NAVIGATE || action.type === CONST.NAVIGATION.ACTION_TYPE.PUSH) && isOnboardingTargetName(getActionTargetName(action))) {
        return true;
    }

    return false;
}

function isNavigatingToJoinWorkspaceTask(action: NavigationAction): boolean {
    if (!isNavigatingToOnboardingFlow(action)) {
        return false;
    }

    return JOIN_WORKSPACE_TASK_SCREENS.has(getActionPayloadScreenName(action) ?? '') && getActionPayloadScreenParams(action)?.isJoinWorkspaceTask === 'true';
}

const ACTIONS_THAT_CAN_LEAVE_ONBOARDING = new Set<string>([
    CONST.NAVIGATION.ACTION_TYPE.NAVIGATE,
    CONST.NAVIGATION.ACTION_TYPE.PUSH,
    CONST.NAVIGATION.ACTION_TYPE.REPLACE,
    CONST.NAVIGATION.ACTION_TYPE.POP_TO,
]);

/**
 * Check if the navigation action takes the user out of the onboarding flow.
 * NAVIGATE/PUSH bury the OnboardingModalNavigator under a new root route (warm deep link, OldDot exitTo).
 * REPLACE/POP_TO remove it, which is what goBack(ROUTES.HOME) becomes in goUp once the target is below it.
 * GO_BACK, POP, SET_PARAMS and DISMISS_MODAL are not checked here: DISMISS_MODAL is how the completed flow exits,
 * shouldPreventReset handles a GO_BACK that leaves onboarding, and the others keep their previous behaviour.
 */
function isNavigatingAwayFromOnboardingFlow(action: NavigationAction): boolean {
    return ACTIONS_THAT_CAN_LEAVE_ONBOARDING.has(action.type) && !isOnboardingTargetName(getActionTargetName(action));
}

/**
 * Check if the navigation action is targeting an onboarding screen.
 * This handles REPLACE actions that target the OnboardingModalNavigator directly.
 */
function isNavigatingToOnboardingFlowWithReplaceAction(action: NavigationAction): boolean {
    return action.type === CONST.NAVIGATION.ACTION_TYPE.REPLACE && getActionTargetName(action) === NAVIGATORS.ONBOARDING_MODAL_NAVIGATOR;
}

/**
 * OnboardingGuard handles ONLY the core NewDot onboarding flow
 */
const OnboardingGuard: NavigationGuard = {
    name: 'OnboardingGuard',

    evaluate: (state, action, context): GuardResult => {
        if (shouldPreventReset(state, action)) {
            return {type: 'BLOCK', reason: 'Cannot reset to non-onboarding screen while on onboarding'};
        }

        if (isRequiredTwoFactorSetupExceptionActive() && (isTwoFactorSetupScreen(getActionPayloadScreenName(action)) || isCurrentlyOnTwoFactorSetupRoute(state))) {
            return {type: 'ALLOW'};
        }

        const isTransitioning = context.currentUrl?.includes(ROUTES.TRANSITION_BETWEEN_APPS);
        const isOnboardingCompleted = hasCompletedGuidedSetupFlowSelector(onboarding) ?? false;
        const isMigratedUser = tryNewDot?.hasBeenAddedToNudgeMigration ?? false;
        const isSingleEntry = hybridApp?.isSingleNewDotEntry ?? false;
        const isFirstTimeHybridAppTransition = (CONFIG.IS_HYBRID_APP && tryNewDot?.isHybridAppOnboardingCompleted !== true) ?? false;
        // If the OnboardingModalNavigator is the currently focused route, the user is already on the
        // onboarding flow. Computed here rather than further down because both the membership check and
        // the readiness wait have to be scoped to it: the skip list returns ALLOW *before* the branch
        // that blocks leaving an open flow, so an unscoped version would let an exitTo, a warm deep link
        // or goBack(HOME) escape onboarding for the whole sync window.
        const isOnboardingFocused = state.routes[state.index]?.name === NAVIGATORS.ONBOARDING_MODAL_NAVIGATOR;

        // The server flag is true for the workspace onboarding itself joined, so it can only be trusted
        // while onboarding has not adopted one. Otherwise a user who joins a workspace from the
        // onboarding "workspaces" step is exempted mid-flow by the next OpenApp.
        const canTrustNonPersonalPolicyFlag = !onboardingPolicyID;
        const isInvitedPolicyMember = !isOnboardingFocused && createIsInvitedPolicyMemberSelector(currentUserAccountID, onboardingPolicyID)(policies);
        const isInvitedOrGroupMember = ((hasNonPersonalPolicy && canTrustNonPersonalPolicyFlag) || isInvitedPolicyMember || wasInvitedToNewDot) ?? false;

        // Never open onboarding from pre-sync cache. On a reopen the invited workspace is already in
        // Onyx while HAS_NON_PERSONAL_POLICY still holds the previous session's false, and there is no
        // way back out once onboarding opens, so a wrong decision here is permanent for that session.
        const isWaitingForInitialSync = context.isAuthenticated && !!hasLoadedApp && !isOnboardingFocused && !isOffline && !isServerDataReady();

        const isNavigatingToJoinWorkspaceTaskRoute = isNavigatingToJoinWorkspaceTask(action);

        // Redirect completed users who try to navigate to onboarding routes (e.g. via deep link), since onboarding
        // is not something they should be able to re-enter once it is done.
        if (onboarding && isOnboardingCompleted && isNavigatingToOnboardingFlow(action) && !isNavigatingToJoinWorkspaceTaskRoute) {
            Log.info('[OnboardingGuard] Redirecting user away from onboarding route to home');
            return {type: 'REDIRECT', route: ROUTES.HOME};
        }

        // Test builds must never enter onboarding, even for the join-workspace exemption above.
        if (CONFIG.SKIP_ONBOARDING && isNavigatingToOnboardingFlow(action)) {
            Log.info('[OnboardingGuard] SKIP_ONBOARDING: redirecting user away from onboarding route to home');
            return {type: 'REDIRECT', route: ROUTES.HOME};
        }

        // Test builds must never enter the onboarding UI. REPLACE into onboarding is normally
        // admitted (real users advance between onboarding steps with forceReplace), but with
        // SKIP_ONBOARDING there is no legitimate way to be mid-onboarding — bounce those too.
        // Scoped to the flag so completed users' REPLACE behaviour is unchanged.
        if (CONFIG.SKIP_ONBOARDING && isNavigatingToOnboardingFlowWithReplaceAction(action)) {
            Log.info('[OnboardingGuard] SKIP_ONBOARDING: redirecting REPLACE into onboarding to home');
            return {type: 'REDIRECT', route: ROUTES.HOME};
        }

        // The onboarding navigator is registered for these sessions too, so keep them out of it here
        const isPromotionalUISuppressed = context.isSupportalSession || isActingAsDelegateSelector(account);
        const isNavigatingWithReplace = isNavigatingToOnboardingFlowWithReplaceAction(action);
        if (isPromotionalUISuppressed && (isNavigatingToOnboardingFlow(action) || isNavigatingWithReplace)) {
            Log.info('[OnboardingGuard] Redirecting copilot or supportal session away from onboarding route to home');
            return {type: 'REDIRECT', route: ROUTES.HOME};
        }

        const skipOnboardingConfig = CONFIG.SKIP_ONBOARDING;
        const isLoading = context.isLoading;

        const shouldSkipOnboarding =
            skipOnboardingConfig ||
            isLoading ||
            isWaitingForInitialSync ||
            isTransitioning ||
            isOnboardingCompleted ||
            isMigratedUser ||
            isInvitedOrGroupMember ||
            isSingleEntry ||
            isFirstTimeHybridAppTransition ||
            isNavigatingWithReplace ||
            // Copilots should not be pushed through onboarding on behalf of the account they are accessing
            isPromotionalUISuppressed;

        if (shouldSkipOnboarding) {
            return {type: 'ALLOW'};
        }

        // Redirecting while already on the onboarding flow would produce a redundant state reset that
        // triggers further actions, creating an infinite navigation loop (APP-7FR). isOnboardingFocused
        // is computed above, because the membership and readiness checks are scoped to it.
        if (isOnboardingFocused) {
            // A deep link that arrives while the app is warm reaches the root router as NAVIGATE/PUSH, and the
            // OldDot transition page follows its blocked exitTo with goBack(ROUTES.HOME), which goUp turns into
            // POP_TO or REPLACE. shouldPreventReset never sees any of these. Block them unless they target
            // onboarding itself. BLOCK is not REDIRECT, so the APP-7FR loop protection above is preserved.
            if (isNavigatingAwayFromOnboardingFlow(action)) {
                return {type: 'BLOCK', reason: 'Cannot navigate away from onboarding before it is completed'};
            }
            return {type: 'ALLOW'};
        }

        // User needs onboarding - calculate the correct step and redirect
        const onboardingRoute = getOnboardingRoute();

        Log.info('[OnboardingGuard] Redirecting to onboarding route', false, {
            onboardingRoute,
            skipOnboardingConfig,
            isLoading,
            isTransitioning,
            isOnboardingCompleted,
            isMigratedUser,
            isSingleEntry,
            isFirstTimeHybridAppTransition,
            isInvitedOrGroupMember,
            isWaitingForInitialSync,
            isNavigatingWithReplace,
        });

        return {
            type: 'REDIRECT',
            route: onboardingRoute,
        };
    },
};

export default OnboardingGuard;
