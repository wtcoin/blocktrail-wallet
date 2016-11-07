angular.module('blocktrail.wallet')
    .controller('WalletCtrl', function($q, $log, $scope, $rootScope, $interval, storageService, sdkService, $translate,
                                       Wallet, Contacts, CONFIG, settingsService, $timeout, $analytics, $cordovaVibration,
                                       $cordovaToast, trackingService, $http, $cordovaDialogs, blocktrailLocalisation) {

        // wait 200ms timeout to allow view to render before hiding loadingscreen
        $timeout(function() {
            $rootScope.hideLoadingScreen = true;

            // allow for one more digest loop
            $timeout(function() {
                if (navigator.splashscreen) {
                    navigator.splashscreen.hide();
                }
            });
        }, 400);

        /*
         * check for extra languages to enable
         *  if one is preferred, prompt user to switch
         */
        $http.get(CONFIG.API_URL + "/v1/" + (CONFIG.TESTNET ? "tBTC" : "BTC") + "/mywallet/config?v=" + CONFIG.VERSION)
            .then(function(result) {
                return result.data.extraLanguages;
            })
            .then(function(extraLanguages) {
                return settingsService.$isLoaded().then(function() {
                    // filter out languages we already know
                    var knownLanguages = blocktrailLocalisation.getLanguages();
                    extraLanguages = extraLanguages.filter(function(language) {
                        return knownLanguages.indexOf(language) === -1;
                    });

                    if (extraLanguages.length === 0) {
                        return;
                    }
                    
                    // enable extra languages
                    _.each(extraLanguages, function(extraLanguage) {
                        blocktrailLocalisation.enableLanguage(extraLanguage, {});
                    });
    
                    // determine (new) preferred language
                    var preferredLanguage = blocktrailLocalisation.setupPreferredLanguage();

                    // store extra languages
                    settingsService.extraLanguages = settingsService.extraLanguages.concat(extraLanguages).unique();
                    return settingsService.$store()
                        .then(function() {
                            // check if we have a new preferred language
                            if (preferredLanguage != settingsService.language && extraLanguages.indexOf(preferredLanguage) !== -1) {
                                // prompt to enable
                                return $cordovaDialogs.confirm(
                                    $translate.instant('MSG_BETTER_LANGUAGE', {
                                        oldLanguage: $translate.instant(blocktrailLocalisation.languageName(settingsService.language)),
                                        newLanguage: $translate.instant(blocktrailLocalisation.languageName(preferredLanguage))
                                    }).sentenceCase(),
                                    $translate.instant('MSG_BETTER_LANGUAGE_TITLE').sentenceCase(),
                                    [$translate.instant('OK'), $translate.instant('CANCEL').sentenceCase()]
                                )
                                    .then(function(dialogResult) {
                                        if (dialogResult == 2) {
                                            return;
                                        }

                                        // enable new language
                                        settingsService.language = preferredLanguage;
                                        $rootScope.changeLanguage(preferredLanguage);

                                        return settingsService.$store();
                                    })
                                ;
                            }
                        })
                    ;
                });
            })
            .then(function() {}, function(e) { console.error('extraLanguages', e && (e.msg || e.message || "" + e)); });

        if (!$rootScope.settings.enablePolling) {
            Wallet.disablePolling();
        }

        $rootScope.getPrice = function() {
            //get a live prices update
            return $q.when(Wallet.price(false).then(function(data) {
                return $rootScope.bitcoinPrices = data;
            }));
        };

        $rootScope.getBlockHeight = function() {
            //get a live block height update (used to calculate confirmations)
            return $q.when(Wallet.blockHeight(false).then(function(data) {
                return $rootScope.blockHeight = data.height;
            }));
        };

        $rootScope.getBalance = function() {
            //get a live balance update
            return $q.when(Wallet.balance(false).then(function(balanceData) {
                $rootScope.balance = balanceData.balance;
                $rootScope.uncBalance = balanceData.uncBalance;

                settingsService.$isLoaded().then(function() {
                    // track activation when balance > 0 and we haven't tracked it yet
                    if (!settingsService.walletActivated && ($rootScope.balance + $rootScope.uncBalance) > 0) {
                        settingsService.walletActivated = true;

                        // only track it for wallets newer than DEFAULT_ACCOUNT_CREATED
                        if (settingsService.accountCreated >= settingsService.DEFAULT_ACCOUNT_CREATED) {
                            trackingService.trackEvent(trackingService.EVENTS.ACTIVATED);
                        }

                        return settingsService.$store().then(function() {
                            return settingsService.$syncSettingsUp();
                        })
                    }
                });

                return {balance: balanceData.balance, uncBalance: balanceData.uncBalance};
            }));
        };

        $rootScope.syncProfile = function() {            
            //sync profile if a pending update is present, else check for upstream changes
            if (!settingsService.profileSynced) {
                settingsService.$syncProfileUp();
            } else {
                settingsService.$syncProfileDown();
            }
        };

        $rootScope.syncContacts = function() {
            //sync any changes to contacts, if syncing enabled
            if (settingsService.enableContacts) {
                Contacts.sync()
                    .then(function() {
                        //rebuild the cached contacts list
                        return Contacts.list(true);
                    })
                    .then(function() {
                        settingsService.contactsLastSync = new Date().valueOf();
                        settingsService.permissionContacts = true;
                        return settingsService.$store();
                    })
                    .catch(function(err) {
                        //check if permission related error happened and update settings accordingly
                        if (err instanceof blocktrail.ContactsPermissionError) {
                            settingsService.permissionContacts = false;
                            settingsService.enableContacts = false;
                            settingsService.$store();

                            //alert user that contact syncing is disabled
                        } else {
                            $log.error(err);
                        }
                    });
            }
        };

        $scope.$on('new_transactions', function(event, transactions) {
            //show popup and vibrate on new receiving tx
            $log.debug('New Transactions have been found!!!', transactions);
            transactions.forEach(function(transaction) {
                if (transaction.wallet_value_change > 0) {
                    $cordovaToast.showLongTop($translate.instant('MSG_NEW_TX').sentenceCase()).then(function(success) {
                        if (settingsService.vibrateOnTx) {
                            $cordovaVibration.vibrate(600);
                        }
                        // success
                    }, function(err) {
                        console.error(err);
                    });
                }
            });
        });


        $scope.$on('ORPHAN', function() {
            //show popup when an Orphan happens and wallet needs to resync
            $cordovaToast.showLongTop($translate.instant('MSG_ORPHAN_BLOCK').sentenceCase());
        });

        // do initial updates then poll for changes, all with small offsets to reducing blocking / slowing down of rendering
        $timeout(function() { $rootScope.getPrice(); }, 1000);
        $timeout(function() { $rootScope.syncProfile(); }, 2000);
        $timeout(function() { $rootScope.syncContacts(); }, 4000);
        $timeout(function() { Wallet.refillOfflineAddresses(1); }, 6000);
        $timeout(function() { settingsService.$syncSettingsDown(); }, 500);

        if (CONFIG.POLL_INTERVAL_PRICE) {
            var pricePolling = $interval(function() {
                if ($rootScope.STATE.ACTIVE) {
                    $rootScope.getPrice();
                }
            }, CONFIG.POLL_INTERVAL_PRICE);
        }

        if (CONFIG.POLL_INTERVAL_BALANCE) {
            var balancePolling = $interval(function() {
                if ($rootScope.STATE.ACTIVE) {
                    $rootScope.getBalance();
                }
            }, CONFIG.POLL_INTERVAL_BALANCE);
        }

        if (CONFIG.POLL_INTERVAL_BLOCKHEIGHT) {
            var blockheightPolling = $interval(function() {
                if ($rootScope.STATE.ACTIVE) {
                    $rootScope.getBlockHeight();
                }
            }, CONFIG.POLL_INTERVAL_BLOCKHEIGHT);
        }

        if (CONFIG.POLL_INTERVAL_CONTACTS) {
            var contactSyncPolling = $interval(function() {
                if ($rootScope.STATE.ACTIVE) {
                    $rootScope.syncContacts();
                }
            }, CONFIG.POLL_INTERVAL_CONTACTS);
        }

        if (CONFIG.POLL_INTERVAL_PROFILE) {
            var profileSyncPolling = $interval(function() {
                if ($rootScope.STATE.ACTIVE) {
                    $rootScope.syncProfile();
                }
            }, CONFIG.POLL_INTERVAL_PROFILE);
        }
    }
);

angular.module('blocktrail.wallet')
    .controller('WalletSummaryCtrl', function($scope, $rootScope, $state, $log, $ionicScrollDelegate, $filter, $http, $q,
                                              $timeout, Wallet, $translate, $stateParams) {
        // update balance from cache
        $scope.transactionsData = [];   //original list of transactions
        $scope.transactionList = [];    //transactions with "date headers" inserted
        $scope.transactionInfo = null;
        $scope.canLoadMoreTransactions = true;
        $scope.isActive = true;
        $scope.paginationOptions = {
            from: 0,
            limit: 25
        };
        $scope.lastDateHeader = 0;      //used to keep track of the last date header added
        $scope.appControl = {
            hideLeft: false,
            showTransactionInfo: false
        };
        $scope.txInfoTemplate = "templates/wallet/partials/wallet.partial.tx-info.html";

        $scope.refreshTransactions = function() {
            $log.debug('refreshTransactions');

            //refresh transactions, block height and wallet balance
            $q.all([
                $q.when($rootScope.getBalance()),
                $q.when($rootScope.getPrice()),
                $q.when($rootScope.getBlockHeight()),
                $q.when(Wallet.pollTransactions())
            ]).then(function(result) {
                $scope.paginationOptions.from = 0;
                $scope.canLoadMoreTransactions = true;
                return $scope.getTransactions($scope.paginationOptions.from, $scope.paginationOptions.limit, true)
                    .then(function() {
                        $scope.$broadcast('scroll.refreshComplete');
                    }, function(err) {
                        $scope.$broadcast('scroll.refreshComplete');
                    });
            }).catch(function (err) {
                //should probably alert user...
                $scope.$broadcast('scroll.refreshComplete');
            });
        };

        $scope.getTransactions = function(from, limit, reset) {
            //get cached transactions
            console.log('getTransactions', from, limit);
            return Wallet.transactions(from, limit).then(function(result) {
                console.log('getTransactions.result', result);

                if (reset) {
                    $scope.lastDateHeader = 0;
                    $scope.transactionsData = [];
                    $scope.transactionList = [];
                }

                $scope.transactionsData = $scope.transactionsData.concat(result);
                $scope.transactionList = $scope.groupTransactions($scope.transactionsData);
                $scope.paginationOptions.from += result.length;
                $scope.canLoadMoreTransactions = result.length >= limit;

                $log.debug("transactionList", $scope.transactionList);
            });
        };

        $scope.loadMoreTransactions = function() {
            $log.debug('loadMoreTransactions');
            //may need to merge existing data set when getting more results?
            // or else check for existing entries so they aren't added more than once when grouping data
            $scope.getTransactions($scope.paginationOptions.from, $scope.paginationOptions.limit).then(function(result) {
                $scope.$broadcast('scroll.infiniteScrollComplete');
            });
        };

        $scope.groupTransactions = function(data) {
            $scope.lastDateHeader = 0;

            var groupedList = [];

            data.forEach(function(transaction) {
                var date = null;

                if (transaction.hash) {
                    date = new Date(transaction.time*1000);
                    date.setHours(0);
                    date.setMinutes(0);
                    date.setSeconds(0);
                    date.setMilliseconds(0);
                    date = date.valueOf();

                    //create the header object
                    if (date < $scope.lastDateHeader || $scope.lastDateHeader == 0) {
                        $scope.lastDateHeader = date;
                        var headerObj = {isHeader: true, date: date};
                        groupedList.push(headerObj);
                    }

                    //add a contact token
                    if (transaction.contact) {
                        if (!transaction.contact.lastName && transaction.contact.firstName) {
                            transaction.contactInitials = transaction.contact.firstName.substr(0, 2);
                        } else if (!transaction.contact.firstName && transaction.contact.lastName) {
                            transaction.contactInitials = transaction.contact.lastName.substr(0, 2);
                        } else if (transaction.contact.firstName && transaction.contact.lastName) {
                            transaction.contactInitials = transaction.contact.firstName.substr(0, 1) + transaction.contact.lastName.substr(0, 1);
                        }
                    } else if (transaction.wallet_value_change > 0) {
                        //received from anonymous
                        transaction.altDisplay = transaction.txin_other_addresses.length >= 1 && transaction.txin_other_addresses[0];
                    } else if (transaction.is_internal) {
                        //sent to self
                        transaction.altDisplay = $translate.instant('INTERNAL_TRANSACTION_TITLE');
                    } else {
                        //sent to anonymous
                        transaction.altDisplay = transaction.txout_other_addresses.length >= 1 && transaction.txout_other_addresses[0];
                    }

                    groupedList.push(transaction);
                }
            });

            return groupedList;
        };

        $scope.showTransaction = function(transaction) {
            transaction.amount = Math.abs(transaction.wallet_value_change);
            if (transaction.wallet_value_change < 0) {
                //subtract fee from amount
                transaction.amount = transaction.amount - transaction.fee;
            }
            $scope.transactionInfo = transaction;
            $scope.appControl.showTransactionInfo = true;
        };

        $scope.onHideTransaction = function() {
            $timeout(function() {$scope.appControl.hideLeft = false;}, 800);
        };

        $scope.onScroll = angular.noop;

        $scope.$on('new_transactions', function(event, transactions) {
            $log.debug('new_transactions', transactions);

            // remove all previously unconfirmed txs
            $scope.transactionsData.forEach(function(tx, index) {
                if (!tx.block_height) {
                    delete $scope.transactionsData[index];
                }
            });

            // add the updated list of unconfirmed txs
            transactions.forEach(function(transaction) {
                $scope.transactionsData.unshift(transaction);
            });

            $scope.$apply(function() {
                //update balance now
                $rootScope.getBalance();

                $scope.transactionList = $scope.groupTransactions($scope.transactionsData);
                $scope.$broadcast('scroll.infiniteScrollComplete');
            });
        });

        $scope.$on('confirmed_transactions', function(event, confirmedTxs) {
            $log.debug('confirmed_transactions', confirmedTxs);
            //refresh the txs that have changed (just update the block heights)
            $scope.$apply(function() {
                //update balance now
                $rootScope.getBalance();

                $scope.transactionList.forEach(function(transaction) {
                    $log.debug('checking tx: ' + transaction.hash + ' against ' + confirmedTxs.length);
                    if (!confirmedTxs.length) {
                        return;
                    }
                    confirmedTxs.forEach(function(confirmedTx, index) {
                        if (confirmedTx.hash == transaction.hash) {
                            $log.debug('found and updated!');
                            transaction.block_height = confirmedTx.block_height;
                            //remove from array to speed things up
                            delete confirmedTxs[index];
                        }
                    });
                });
            });
        });

        $scope.$on('ORPHAN', function() {
            if ($scope.isActive) {
                $timeout(function() {
                    $log.debug('WalletCtrl.ORPHAN');

                    $scope.refreshTransactions();
                });
            }
        });

        $scope.$on('$ionicView.leave', function() {
            $scope.isActive = false;
        });

        $scope.$on("$stateChangeStart", function() {
            $scope.appControl.showTransactionInfo = false;
        });

        $scope.$on('$ionicView.enter', function() {
            // force refresh with spinner, only if scope has been initialised and cached already
            if ($stateParams.refresh && !$scope.isActive) {
                $scope.refreshTransactions();

                $scope.displaySpinner = true;
            } else {
                // when not forced give it a slight offset to allow rendering first
                $timeout(function() {
                    $log.debug('$ionicView.enter -> refreshTransactions');
                    $scope.refreshTransactions();
                }, 300);
            }

            $scope.isActive = true;
            $timeout(function() {
                $ionicScrollDelegate.scrollTop();
            });

        });

        $scope.$on('scroll.refreshComplete', function() {
            $scope.displaySpinner = false;
        });

    });
