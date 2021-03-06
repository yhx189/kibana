import _ from 'lodash';
import { fatalError } from 'ui/notify';
import { IndexPatternMissingIndices } from 'ui/errors';
import 'ui/directives/validate_index_pattern';
import 'ui/directives/auto_select_if_only_one';
import 'ui/directives/documentation_href';
import uiRoutes from 'ui/routes';
import { uiModules } from 'ui/modules';
import { SavedObjectsClientProvider } from 'ui/saved_objects';
import template from './create_index_pattern_wizard.html';
import { sendCreateIndexPatternRequest } from './send_create_index_pattern_request';
import { renderStepIndexPattern, destroyStepIndexPattern } from './components/step_index_pattern';
import { renderStepTimeField, destroyStepTimeField } from './components/step_time_field';
import './create_index_pattern_wizard.less';

uiRoutes
  .when('/management/kibana/index', {
    template,
  });

uiModules.get('apps/management')
  .controller('managementIndicesCreate', function (
    $routeParams,
    $scope,
    $timeout,
    config,
    es,
    indexPatterns,
    kbnUrl,
    Notifier,
    Promise,
    Private,
  ) {
  // This isn't ideal. We want to avoid searching for 20 indices
  // then filtering out the majority of them because they are sysetm indices.
  // We'd like to filter system indices out in the query
  // so if we can accomplish that in the future, this logic can go away
    const ESTIMATED_NUMBER_OF_SYSTEM_INDICES = 100;
    const MAX_NUMBER_OF_MATCHING_INDICES = 20;
    const MAX_SEARCH_SIZE = MAX_NUMBER_OF_MATCHING_INDICES + ESTIMATED_NUMBER_OF_SYSTEM_INDICES;
    const notify = new Notifier();
    const savedObjectsClient = Private(SavedObjectsClientProvider);

    $scope.$on('$destroy', () => {
      destroyStepIndexPattern();
      destroyStepTimeField();
    });

    // Configure the new index pattern we're going to create.
    this.formValues = {
      id: $routeParams.id ? decodeURIComponent($routeParams.id) : undefined,
      name: '',
      expandWildcard: false,
      timeFieldOption: undefined,
    };

    // UI state.
    this.timeFieldOptions = [];
    this.wizardStep = 'indexPattern';
    this.isFetchingExistingIndices = true;
    this.isFetchingMatchingIndices = false;
    this.isFetchingTimeFieldOptions = false;
    this.isCreatingIndexPattern = false;
    this.doesIncludeSystemIndices = false;
    let allIndices = [];
    const matchingIndices = [];
    const partialMatchingIndices = [];
    this.allIndices = [];
    this.matchingIndices = [];
    this.partialMatchingIndices = [];

    function createReasonableWait() {
      return new Promise(resolve => {
      // Make every fetch take a set amount of time so the user gets some feedback that something
      // is happening.
        $timeout(() => {
          resolve();
        }, 500);
      });
    }

    function getIndices(rawPattern, limit = MAX_SEARCH_SIZE) {
      const pattern = rawPattern.trim();

      // Searching for `*:` fails for CCS environments. The search request
      // is worthless anyways as the we should only send a request
      // for a specific query (where we do not append *) if there is at
      // least a single character being searched for.
      if (pattern === '*:') {
        return [];
      }

      const params = {
        index: pattern,
        ignore: [404],
        body: {
          size: 0, // no hits
          aggs: {
            indices: {
              terms: {
                field: '_index',
                size: limit,
              }
            }
          }
        }
      };

      return es.search(params)
        .then(response => {
          if (!response || response.error || !response.aggregations) {
            return [];
          }

          return _.sortBy(response.aggregations.indices.buckets.map(bucket => {
            return {
              name: bucket.key
            };
          }), 'name');
        })
        .catch(err => {
          const type = _.get(err, 'body.error.caused_by.type');
          if (type === 'index_not_found_exception') {
            // This happens in a CSS environment when the controlling node returns a 500 even though the data
            // nodes returned a 404. Remove this when/if this is handled: https://github.com/elastic/elasticsearch/issues/27461
            return [];
          }
          throw err;
        });
    }

    const whiteListIndices = indices => {
      if (!indices) {
        return indices;
      }

      const acceptableIndices = this.doesIncludeSystemIndices
        ? indices
        // All system indices begin with a period.
        : indices.filter(index => !index.name.startsWith('.'));

      return acceptableIndices.slice(0, MAX_NUMBER_OF_MATCHING_INDICES);
    };

    const updateWhiteListedIndices = () => {
      this.allIndices = whiteListIndices(allIndices);
      this.matchingIndices = whiteListIndices(matchingIndices);
      this.partialMatchingIndices = whiteListIndices(partialMatchingIndices);
    };

    this.onIncludeSystemIndicesChange = () => {
      updateWhiteListedIndices();
      this.renderStepIndexPatternReact();
    };

    this.fetchExistingIndices = () => {
      this.isFetchingExistingIndices = true;
      const allExistingLocalIndicesPattern = '*';

      Promise.all([
        getIndices(allExistingLocalIndicesPattern),
        createReasonableWait()
      ])
        .then(([allIndicesResponse]) => {
          // Cache all indices.
          allIndices = allIndicesResponse;
          updateWhiteListedIndices();
          this.isFetchingExistingIndices = false;
          if (allIndices.length) {
            this.renderStepIndexPatternReact();
          }
        }).catch(error => {
          notify.error(error);
          this.isFetchingExistingIndices = false;
        });
    };

    this.isSystemIndicesCheckBoxVisible = () => (
      this.wizardStep === 'indexPattern'
    );

    this.goToIndexPatternStep = () => {
      this.wizardStep = 'indexPattern';
      this.renderStepIndexPatternReact();
    };

    this.renderStepIndexPatternReact = () => {
      $scope.$$postDigest(() => renderStepIndexPattern(
        allIndices,
        this.formValues.name,
        this.doesIncludeSystemIndices,
        es,
        savedObjectsClient,
        query => {
          destroyStepIndexPattern();
          this.formValues.name = query;
          this.goToTimeFieldStep();
          $scope.$apply();
        }
      ));
    };

    this.renderStepTimeFieldReact = () => {
      $scope.$$postDigest(() => renderStepTimeField(
        this.formValues.name,
        indexPatterns,
        () => {
          destroyStepTimeField();
          this.goToIndexPatternStep();
          $scope.$apply();
        },
        this.createIndexPattern
      ));
    };

    this.goToTimeFieldStep = () => {
      this.wizardStep = 'timeField';
      this.renderStepTimeFieldReact();
    };

    this.hasIndices = () => (
      this.allIndices.length
    );

    this.createIndexPattern = (timeFieldName, id) => {
      this.isCreatingIndexPattern = true;

      const { name } = this.formValues;

      sendCreateIndexPatternRequest(indexPatterns, {
        id,
        name,
        timeFieldName: timeFieldName === '-1' ? null : timeFieldName,
      }).then(createdId => {
        if (!createdId) {
          return;
        }

        if (!config.get('defaultIndex')) {
          config.set('defaultIndex', createdId);
        }

        indexPatterns.cache.clear(createdId);
        kbnUrl.change(`/management/kibana/indices/${createdId}`);
      }).catch(err => {
        if (err instanceof IndexPatternMissingIndices) {
          return notify.error(`Couldn't locate any indices matching that pattern. Please add the index to Elasticsearch`);
        }

        fatalError(err);
      }).finally(() => {
        this.isCreatingIndexPattern = false;
      });
    };

    this.fetchExistingIndices();
  });
