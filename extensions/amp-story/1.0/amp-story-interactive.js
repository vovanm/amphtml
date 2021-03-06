/**
 * Copyright 2019 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  ANALYTICS_TAG_NAME,
  StoryAnalyticsEvent,
  getAnalyticsService,
} from './story-analytics';
import {AnalyticsVariable, getVariableService} from './variable-service';
import {CSS} from '../../../build/amp-story-interactive-1.0.css';
import {Services} from '../../../src/services';
import {StateProperty, getStoreService} from './amp-story-store-service';
import {
  addParamsToUrl,
  appendPathToUrl,
  assertAbsoluteHttpOrHttpsUrl,
} from '../../../src/url';
import {closest} from '../../../src/dom';
import {createShadowRootWithStyle} from './utils';
import {dev, devAssert} from '../../../src/log';
import {dict} from '../../../src/utils/object';
import {getRequestService} from './amp-story-request-service';
import {toArray} from '../../../src/types';

/** @const {string} */
const TAG = 'amp-story-interactive';

/**
 * @const @enum {number}
 */
export const InteractiveType = {
  QUIZ: 0,
  POLL: 1,
};

/** @const {string} */
const ENDPOINT_INVALID_ERROR =
  'The publisher has specified an invalid datastore endpoint';

/**
 * @typedef {{
 *    optionIndex: number,
 *    totalCount: number,
 *    selectedByUser: boolean,
 * }}
 */
export let InteractiveOptionType;

/**
 * @typedef {{
 *    options: !Array<InteractiveOptionType>,
 * }}
 */
export let InteractiveResponseType;

/**
 * @typedef {{
 *    optionIndex: number,
 *    text: string,
 *    correct: ?string
 * }}
 */
export let OptionConfigType;

/** @const {Array<Object>} fontFaces with urls from https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&amp;display=swap */
const fontsToLoad = [
  {
    family: 'Poppins',
    weight: '400',
    src:
      "url(https://fonts.gstatic.com/s/poppins/v9/pxiEyp8kv8JHgFVrJJfecnFHGPc.woff2) format('woff2')",
  },
  {
    family: 'Poppins',
    weight: '700',
    src:
      "url(https://fonts.gstatic.com/s/poppins/v9/pxiByp8kv8JHgFVrLCz7Z1xlFd2JQEk.woff2) format('woff2')",
  },
];

/**
 * Interactive abstract class with shared functionality for interactive components.
 *
 * Lifecycle:
 * 1) When created, the abstract class will call the buildComponent() method implemented by each concrete class.
 *   NOTE: When created, the component will receive a .i-amphtml-story-interactive-component, inheriting useful CSS variables.
 *
 * 2) If an endpoint is specified, it will retrieve aggregate results from the backend and process them. If the clientId
 *   has responded in a previous session, the component will change to a post-selection state. Otherwise it will wait
 *   for user selection.
 *   NOTE: Click listeners will be attached to all options, which require .i-amphtml-story-interactive-option.
 *
 * 3) On user selection, it will process the backend results (if endpoint specified) and display the selected option.
 *   Analytic events will be sent, percentages updated (implemented by the concrete class), and backend posted with the
 *   user response. Classes will be added to the component and options accordingly.
 *   NOTE: On option selected, the selection will receive a .i-amphtml-story-interactive-option-selected, and the root element
 *   will receive a .i-amphtml-story-interactive-post-selection. Optionally, if the endpoint returned aggregate results,
 *   the root element will also receive a .i-amphtml-story-interactive-has-data.
 *
 * @abstract
 */
export class AmpStoryInteractive extends AMP.BaseElement {
  /**
   * @param {!AmpElement} element
   * @param {!InteractiveType} type
   * @param {!Array<number>} bounds the bounds on number of options, inclusive
   */
  constructor(element, type, bounds = [2, 4]) {
    super(element);

    /** @protected @const {InteractiveType} */
    this.interactiveType_ = type;

    /** @protected @const {!./story-analytics.StoryAnalyticsService} */
    this.analyticsService_ = getAnalyticsService(this.win, element);

    /** @protected {?Promise<?InteractiveResponseType|?JsonObject|undefined>} */
    this.backendDataPromise_ = null;

    /** @protected {?Promise<!../../../src/service/cid-impl.CidDef>} */
    this.clientIdService_ = Services.cidForDoc(this.element);

    /** @protected {?Promise<JsonObject>} */
    this.clientIdPromise_ = null;

    /** @protected {boolean} */
    this.hasUserSelection_ = false;

    /** @private {!Array<number>} min and max number of options, inclusive */
    this.optionBounds_ = bounds;

    /** @private {?Array<!Element>} */
    this.optionElements_ = null;

    /** @protected {?Array<!OptionConfigType>} */
    this.options_ = null;

    /** @protected {?Array<!InteractiveOptionType>} */
    this.optionsData_ = null;

    /** @protected {?Element} */
    this.rootEl_ = null;

    /** @protected {?string} */
    this.interactiveId_ = null;

    /** @protected {!./amp-story-request-service.AmpStoryRequestService} */
    this.requestService_ = getRequestService(this.win, this.element);

    /** @const @protected {!./amp-story-store-service.AmpStoryStoreService} */
    this.storeService_ = getStoreService(this.win);

    /** @protected {../../../src/service/url-impl.Url} */
    this.urlService_ = Services.urlForDoc(this.element);

    /** @const @protected {!./variable-service.AmpStoryVariableService} */
    this.variableService_ = getVariableService(this.win);
  }

  /**
   * Gets the root element.
   * @visibleForTesting
   * @return {?Element}
   */
  getRootElement() {
    return this.rootEl_;
  }

  /**
   * Gets the options.
   * @protected
   * @return {!Array<!Element>}
   */
  getOptionElements() {
    if (!this.optionElements_) {
      this.optionElements_ = toArray(
        this.rootEl_.querySelectorAll('.i-amphtml-story-interactive-option')
      );
    }
    return this.optionElements_;
  }

  /** @override */
  buildCallback(concreteCSS = '') {
    this.loadFonts_();
    this.options_ = this.parseOptions_();
    this.rootEl_ = this.buildComponent();
    this.rootEl_.classList.add('i-amphtml-story-interactive-container');
    this.element.classList.add('i-amphtml-story-interactive-component');
    this.adjustGridLayer_();
    this.initializeListeners_();
    devAssert(this.element.children.length == 0, 'Too many children');
    createShadowRootWithStyle(
      this.element,
      dev().assertElement(this.rootEl_),
      CSS + concreteCSS
    );
  }

  /**
   * @private
   */
  loadFonts_() {
    if (
      !AmpStoryInteractive.loadedFonts &&
      this.win.document.fonts &&
      FontFace
    ) {
      fontsToLoad.forEach((fontProperties) => {
        const font = new FontFace(fontProperties.family, fontProperties.src, {
          weight: fontProperties.weight,
          style: 'normal',
        });
        font.load().then(() => {
          this.win.document.fonts.add(font);
        });
      });
    }
    AmpStoryInteractive.loadedFonts = true;
  }

  /**
   * Reads the element attributes prefixed with option- and returns them as a list.
   * eg: [
   *      {optionIndex: 0, text: 'Koala'},
   *      {optionIndex: 1, text: 'Developers', correct: ''}
   *    ]
   * @protected
   * @return {?Array<!OptionConfigType>}
   */
  parseOptions_() {
    const options = [];
    toArray(this.element.attributes).forEach((attr) => {
      // Match 'option-#-type' (eg: option-1-text, option-2-image, option-3-correct...)
      if (attr.name.match(/^option-\d+-\w+$/)) {
        const splitParts = attr.name.split('-');
        const optionNumber = parseInt(splitParts[1], 10);
        // Add all options in order on the array with correct index.
        while (options.length < optionNumber) {
          options.push({'optionIndex': options.length});
        }
        options[optionNumber - 1][splitParts[2]] = attr.value;
      }
    });
    if (
      options.length >= this.optionBounds_[0] &&
      options.length <= this.optionBounds_[1]
    ) {
      return options;
    }
    devAssert(
      options.length >= this.optionBounds_[0] &&
        options.length <= this.optionBounds_[1],
      `Improper number of options. Expected ${this.optionBounds_[0]} <= options <= ${this.optionBounds_[1]} but got ${options.length}.`
    );
    dev().error(
      TAG,
      `Improper number of options. Expected ${this.optionBounds_[0]} <= options <= ${this.optionBounds_[1]} but got ${options.length}.`
    );
  }

  /**
   * Generates the template from the config_ Map.
   *
   * @return {!Element} rootEl_
   * @protected @abstract
   */
  buildComponent() {
    // Subclass must override.
  }

  /** @override */
  layoutCallback() {
    return (this.backendDataPromise_ = this.element.hasAttribute('endpoint')
      ? this.retrieveInteractiveData_()
      : Promise.resolve());
  }

  /**
   * Gets a Promise to return the unique AMP clientId
   * @private
   * @return {Promise<string>}
   */
  getClientId_() {
    if (!this.clientIdPromise_) {
      this.clientIdPromise_ = this.clientIdService_.then((data) => {
        return data.get(
          {scope: 'amp-story', createCookieIfNotPresent: true},
          /* consent */ Promise.resolve()
        );
      });
    }
    return this.clientIdPromise_;
  }

  /**
   * Reacts to RTL state updates and triggers the UI for RTL.
   * @param {boolean} rtlState
   * @private
   */
  onRtlStateUpdate_(rtlState) {
    this.mutateElement(() => {
      rtlState
        ? this.rootEl_.setAttribute('dir', 'rtl')
        : this.rootEl_.removeAttribute('dir');
    });
  }

  /** @override */
  isLayoutSupported(layout) {
    return layout === 'container';
  }

  /**
   * Add classes to adjust the bottom padding on the grid-layer
   * to prevent overlap with the component.
   *
   * @private
   */
  adjustGridLayer_() {
    const gridLayer = closest(dev().assertElement(this.element), (el) => {
      return el.tagName.toLowerCase() === 'amp-story-grid-layer';
    });

    gridLayer.classList.add('i-amphtml-story-has-interactive');

    if (gridLayer.parentElement.querySelector('amp-story-cta-layer')) {
      gridLayer.classList.add('i-amphtml-story-has-CTA-layer');
    }

    if (gridLayer.parentElement.querySelector('amp-story-page-attachment')) {
      gridLayer.classList.add('i-amphtml-story-has-page-attachment');
    }
  }

  /**
   * Attaches functions to each option to handle state transition.
   * @private
   */
  initializeListeners_() {
    // Add a listener for changes in the RTL state
    this.storeService_.subscribe(
      StateProperty.RTL_STATE,
      (rtlState) => {
        this.onRtlStateUpdate_(rtlState);
      },
      true /** callToInitialize */
    );

    // Add a click listener to the element to trigger the class change
    this.rootEl_.addEventListener('click', (e) => this.handleTap_(e));
  }

  /**
   * Handles a tap event on the quiz element.
   * @param {Event} e
   * @private
   */
  handleTap_(e) {
    if (this.hasUserSelection_) {
      return;
    }

    const optionEl = closest(
      dev().assertElement(e.target),
      (element) => {
        return element.classList.contains('i-amphtml-story-interactive-option');
      },
      this.rootEl_
    );

    if (optionEl) {
      this.handleOptionSelection_(optionEl);
    }
  }

  /**
   * Triggers the analytics event for quiz response.
   *
   * @param {!Element} optionEl
   * @private
   */
  triggerAnalytics_(optionEl) {
    this.variableService_.onVariableUpdate(
      AnalyticsVariable.STORY_INTERACTIVE_ID,
      this.element.getAttribute('id')
    );
    this.variableService_.onVariableUpdate(
      AnalyticsVariable.STORY_INTERACTIVE_RESPONSE,
      optionEl.optionIndex_
    );
    this.variableService_.onVariableUpdate(
      AnalyticsVariable.STORY_INTERACTIVE_TYPE,
      this.interactiveType_
    );

    this.element[ANALYTICS_TAG_NAME] = this.element.tagName;
    this.analyticsService_.triggerEvent(
      StoryAnalyticsEvent.INTERACTIVE,
      this.element
    );
  }

  /**
   * Update component to reflect values in the data obtained.
   * Called when user has responded (in this session or before).
   *
   * @protected @abstract
   * @param {!Array<!InteractiveOptionType>} unusedOptionsData
   */
  updateOptionPercentages_(unusedOptionsData) {
    // Subclass must implement
  }

  /**
   * Preprocess the percentages for display.
   *
   * @param {!Array<!InteractiveOptionType>} optionsData
   * @return {Array<number>}
   * @protected
   */
  preprocessPercentages_(optionsData) {
    const totalResponseCount = optionsData.reduce(
      (acc, response) => acc + response['totalCount'],
      0
    );

    let percentages = optionsData.map((e) =>
      ((100 * e['totalCount']) / totalResponseCount).toFixed(2)
    );
    let total = percentages.reduce((acc, x) => acc + Math.round(x), 0);

    // Special case: divide remainders by three if they break 100,
    // 3 is the maximum above 100 the remainders can add.
    if (total > 100) {
      percentages = percentages.map((percentage) =>
        (percentage - (2 * (percentage - Math.floor(percentage))) / 3).toFixed(
          2
        )
      );
      total = percentages.reduce((acc, x) => (acc += Math.round(x)), 0);
    }

    if (total === 100) {
      return percentages.map((percentage) => Math.round(percentage));
    }

    // Truncate all and round up those with the highest remainders,
    // preserving order and ties and adding to 100 (if possible given ties and ordering).
    let remainder = 100 - total;

    let preserveOriginal = percentages.map((percentage, index) => {
      return {
        originalIndex: index,
        value: percentage,
        remainder: (percentage - Math.floor(percentage)).toFixed(2),
      };
    });
    preserveOriginal.sort(
      (left, right) =>
        // Break remainder ties using the higher value.
        right.remainder - left.remainder || right.value - left.value
    );

    const finalPercentages = [];
    while (remainder > 0 && preserveOriginal.length !== 0) {
      const highestRemainderObj = preserveOriginal[0];

      const ties = preserveOriginal.filter(
        (percentageObj) => percentageObj.value === highestRemainderObj.value
      );
      preserveOriginal = preserveOriginal.filter(
        (percentageObj) => percentageObj.value !== highestRemainderObj.value
      );

      const toRoundUp =
        ties.length <= remainder && highestRemainderObj.remainder !== '0.00';

      ties.forEach((percentageObj) => {
        finalPercentages[percentageObj.originalIndex] =
          Math.floor(percentageObj.value) + (toRoundUp ? 1 : 0);
      });

      // Update the remainder given additions to the percentages.
      remainder -= toRoundUp ? ties.length : 0;
    }

    preserveOriginal.forEach((percentageObj) => {
      finalPercentages[percentageObj.originalIndex] = Math.floor(
        percentageObj.value
      );
    });

    return finalPercentages;
  }

  /**
   * Triggers changes to component state on response interactive.
   *
   * @param {!Element} optionEl
   * @private
   */
  handleOptionSelection_(optionEl) {
    this.backendDataPromise_
      .then(() => {
        if (this.hasUserSelection_) {
          return;
        }

        this.triggerAnalytics_(optionEl);
        this.hasUserSelection_ = true;

        if (this.optionsData_) {
          this.optionsData_[optionEl.optionIndex_]['totalCount']++;
          this.optionsData_[optionEl.optionIndex_]['selectedByUser'] = true;
        }

        this.mutateElement(() => {
          if (this.optionsData_) {
            this.updateOptionPercentages_(this.optionsData_);
          }
          this.updateToPostSelectionState_(optionEl);
        });

        if (this.element.hasAttribute('endpoint')) {
          this.executeInteractiveRequest_('POST', optionEl.optionIndex_);
        }
      })
      .catch(() => {
        // If backend is not properly connected, still update state.
        this.triggerAnalytics_(optionEl);
        this.hasUserSelection_ = true;
        this.mutateElement(() => {
          this.updateToPostSelectionState_(optionEl);
        });
      });
  }

  /**
   * Get the Interactive data from the datastore
   *
   * @return {?Promise<?InteractiveResponseType|?JsonObject|undefined>}
   * @private
   */
  retrieveInteractiveData_() {
    return this.executeInteractiveRequest_('GET').then((response) => {
      this.handleSuccessfulDataRetrieval_(
        /** @type {InteractiveResponseType} */ (response)
      );
    });
  }

  /**
   * Executes a Interactive API call.
   *
   * @param {string} method GET or POST.
   * @param {number=} optionSelected
   * @return {!Promise<!InteractiveResponseType|string>}
   * @private
   */
  executeInteractiveRequest_(method, optionSelected = undefined) {
    let url = this.element.getAttribute('endpoint');
    if (!assertAbsoluteHttpOrHttpsUrl(url)) {
      return Promise.reject(ENDPOINT_INVALID_ERROR);
    }

    if (!this.interactiveId_) {
      const pageId = closest(dev().assertElement(this.element), (el) => {
        return el.tagName.toLowerCase() === 'amp-story-page';
      }).getAttribute('id');
      this.interactiveId_ = `CANONICAL_URL+${pageId}`;
    }

    return this.getClientId_().then((clientId) => {
      const requestOptions = {'method': method};
      const requestParams = dict({
        'interactiveType': this.interactiveType_,
        'clientId': clientId,
      });
      url = appendPathToUrl(
        this.urlService_.parse(url),
        dev().assertString(this.interactiveId_)
      );
      if (requestOptions['method'] === 'POST') {
        requestOptions['body'] = {'optionSelected': optionSelected};
        requestOptions['headers'] = {'Content-Type': 'application/json'};
        url = appendPathToUrl(this.urlService_.parse(url), '/react');
      }
      url = addParamsToUrl(url, requestParams);
      return this.requestService_
        .executeRequest(url, requestOptions)
        .catch((err) => dev().error(TAG, err));
    });
  }

  /**
   * Handles incoming interactive data response
   *
   * RESPONSE FORMAT
   * {
   *  options: [
   *    {
   *      optionIndex:
   *      totalCount:
   *      selectedByUser:
   *    },
   *    ...
   *  ]
   * }
   * @param {InteractiveResponseType|undefined} response
   * @private
   */
  handleSuccessfulDataRetrieval_(response) {
    if (!(response && response['options'])) {
      devAssert(
        response && 'options' in response,
        `Invalid interactive response, expected { data: InteractiveResponseType, ...} but received ${response}`
      );
      dev().error(
        TAG,
        `Invalid interactive response, expected { data: InteractiveResponseType, ...} but received ${response}`
      );
      return;
    }
    const numOptions = this.rootEl_.querySelectorAll(
      '.i-amphtml-story-interactive-option'
    ).length;
    // Only keep the visible options to ensure visible percentages add up to 100.
    this.updateComponentOnDataRetrieval_(
      response['options'].slice(0, numOptions)
    );
  }

  /**
   * Updates the quiz to reflect the state of the remote data.
   * @param {!Array<InteractiveOptionType>} data
   * @private
   */
  updateComponentOnDataRetrieval_(data) {
    const options = this.rootEl_.querySelectorAll(
      '.i-amphtml-story-interactive-option'
    );

    this.optionsData_ = data;
    data.forEach((response, index) => {
      if (response.selectedByUser) {
        this.hasUserSelection_ = true;
        this.mutateElement(() => {
          this.updateOptionPercentages_(data);
          this.updateToPostSelectionState_(options[index]);
        });
      }
    });
  }

  /**
   * Updates the selected classes on option selected.
   * @param {!Element} selectedOption
   * @private
   */
  updateToPostSelectionState_(selectedOption) {
    this.rootEl_.classList.add('i-amphtml-story-interactive-post-selection');
    selectedOption.classList.add('i-amphtml-story-interactive-option-selected');

    if (this.optionsData_) {
      this.rootEl_.classList.add('i-amphtml-story-interactive-has-data');
    }
  }
}
