var Stratum = require('stratum-pool');
var redis   = require('redis');
var net     = require('net');

var MposCompatibility = require('./mposCompatibility.js');
var ShareProcessor = require('./shareProcessor.js');

module.exports = function(logger){

    var _this = this;

    var poolConfigs  = JSON.parse(process.env.pools);
    var portalConfig = JSON.parse(process.env.portalConfig);

    var forkId = process.env.forkId;
    
    var pools = {};

    var proxySwitch = {};

    var redisClient = redis.createClient(portalConfig.redis.port, portalConfig.redis.host);

    //Handle messages from master process sent via IPC
    process.on('message', function(message) {
        switch(message.type){

            case 'banIP':
                for (var p in pools){
                    if (pools[p].stratumServer)
                        pools[p].stratumServer.addBannedIP(message.ip);
                }
                break;

            case 'blocknotify':

                var messageCoin = message.coin.toLowerCase();
                var poolTarget = Object.keys(pools).filter(function(p){
                    return p.toLowerCase() === messageCoin;
                })[0];

                if (poolTarget)
                    pools[poolTarget].processBlockNotify(message.hash, 'blocknotify script');

                break;

            // IPC message for pool switching
            case 'coinswitch':
                var logSystem = 'Proxy';
                var logComponent = 'Switch';
                var logSubCat = 'Thread ' + (parseInt(forkId) + 1);

                var switchName = message.switchName;
                if (!portalConfig.switching[switchName]) {
                    logger.error(logSystem, logComponent, logSubCat, 'Switching key not recognized: ' + switchName);
                }

                var messageCoin = message.coin.toLowerCase();
                var newCoin = Object.keys(pools).filter(function(p){
                    return p.toLowerCase() === messageCoin;
                })[0];

                if (!newCoin){
                    logger.error(logSystem, logComponent, logSubCat, 'Switch message to coin that is not recognized: ' + messageCoin);
                    break;
                }

                var algo = poolConfigs[newCoin].coin.algorithm;

                if (algo !== proxySwitch[switchName].algorithm){
                    logger.error(logSystem, logComponent, logSubCat, 'Cannot switch a '
                        + proxySwitch[switchName].algorithm
                        + ' algo pool to coin ' + newCoin + ' with ' + algo + ' algo');
                    break;
                }

                var newPool = pools[newCoin];
                var oldCoin = proxySwitch[switchName].currentPool;
                var oldPool = pools[oldCoin];
                var proxyPorts = Object.keys(proxySwitch[switchName].ports);

                if (newCoin == oldCoin) {
                    logger.debug(logSystem, logComponent, logSubCat, 'Switch message would have no effect - ignoring ' + newCoin);
                    break;
                }

                logger.debug(logSystem, logComponent, logSubCat, 'Proxy message for ' + algo + ' from ' + oldCoin + ' to ' + newCoin);

                if (newPool) {
                    oldPool.relinquishMiners(
                        function (miner, cback) { 
                            // relinquish miners that are attached to one of the "Auto-switch" ports and leave the others there.
                            cback(proxyPorts.indexOf(miner.client.socket.localPort.toString()) !== -1)
                        }, 
                        function (clients) {
                            newPool.attachMiners(clients);
                        }
                    );
                    proxySwitch[switchName].currentPool = newCoin;

                    redisClient.hset('proxyState', algo, newCoin, function(error, obj) {
                        if (error) {
                            logger.error(logSystem, logComponent, logSubCat, 'Redis error writing proxy config: ' + JSON.stringify(err))
                        }
                        else {
                            logger.debug(logSystem, logComponent, logSubCat, 'Last proxy state saved to redis for ' + algo);
                        }
                    });

                }
                break;
        }
    });


    Object.keys(poolConfigs).forEach(function(coin) {

        var poolOptions = poolConfigs[coin];

        var logSystem = 'Pool';
        var logComponent = coin;
        var logSubCat = 'Thread ' + (parseInt(forkId) + 1);

        var handlers = {
            auth: function(){},
            share: function(){},
            diff: function(){}
        };

        var shareProcessing = poolOptions.shareProcessing;

        //Functions required for MPOS compatibility
        if (shareProcessing && shareProcessing.mpos && shareProcessing.mpos.enabled){
            var mposCompat = new MposCompatibility(logger, poolOptions);

            handlers.auth = function(port, workerName, password, authCallback){
                mposCompat.handleAuth(workerName, password, authCallback);
            };

            handlers.share = function(isValidShare, isValidBlock, data){
                mposCompat.handleShare(isValidShare, isValidBlock, data);
            };

            handlers.diff = function(workerName, diff){
                mposCompat.handleDifficultyUpdate(workerName, diff);
            }
        }

        //Functions required for internal payment processing
        else if (shareProcessing && shareProcessing.internal && shareProcessing.internal.enabled){

            var shareProcessor = new ShareProcessor(logger, poolOptions);

            handlers.auth = function(port, workerName, password, authCallback){
                if (shareProcessing.internal.validateWorkerAddress !== true)
                    authCallback(true);
                else {
                    port = port.toString();
                    if (portalConfig.switching) {
                        for (var switchName in portalConfig.switching) {
                            if (portalConfig.switching[switchName].enabled && Object.keys(portalConfig.switching[switchName].ports).indexOf(port) !== -1) {
                                if (workerName.length === 40) {
                                    try {
                                        new Buffer(workerName, 'hex');
                                        authCallback(true);
                                    }
                                    catch (e) {
                                        authCallback(false);
                                    }
                                }
                                else
                                    authCallback(false);
                                return;
                            }
                        }
                    }

                    pool.daemon.cmd('validateaddress', [workerName], function(results){
                        var isValid = results.filter(function(r){return r.response.isvalid}).length > 0;
                        authCallback(isValid);
                    });
                }
            };

            handlers.share = function(isValidShare, isValidBlock, data){
                shareProcessor.handleShare(isValidShare, isValidBlock, data);
            };
        }

        var authorizeFN = function (ip, port, workerName, password, callback) {
            handlers.auth(port, workerName, password, function(authorized){

                var authString = authorized ? 'Authorized' : 'Unauthorized ';

                logger.debug(logSystem, logComponent, logSubCat, authString + ' ' + workerName + ':' + password + ' [' + ip + ']');
                callback({
                    error: null,
                    authorized: authorized,
                    disconnect: false
                });
            });
        };


        var pool = Stratum.createPool(poolOptions, authorizeFN, logger);
        pool.on('share', function(isValidShare, isValidBlock, data){

            var shareData = JSON.stringify(data);

            if (data.blockHash && !isValidBlock)
                logger.debug(logSystem, logComponent, logSubCat, 'We thought a block was found but it was rejected by the daemon, share data: ' + shareData);

            else if (isValidBlock)
                logger.debug(logSystem, logComponent, logSubCat, 'Block found: ' + data.blockHash);

            if (isValidShare)
                logger.debug(logSystem, logComponent, logSubCat, 'Share accepted at diff ' + data.difficulty + '/' + data.shareDiff + ' by ' + data.worker + ' [' + data.ip + ']' );

            else if (!isValidShare)
                logger.debug(logSystem, logComponent, logSubCat, 'Share rejected: ' + shareData);

            handlers.share(isValidShare, isValidBlock, data)


        }).on('difficultyUpdate', function(workerName, diff){
            logger.debug(logSystem, logComponent, logSubCat, 'Difficulty update to diff ' + diff + ' workerName=' + JSON.stringify(workerName));
            handlers.diff(workerName, diff);
        }).on('log', function(severity, text) {
            logger[severity](logSystem, logComponent, logSubCat, text);
        }).on('banIP', function(ip, worker){
            process.send({type: 'banIP', ip: ip});
        });

        pool.start();
        pools[poolOptions.coin.name] = pool;
    });


    if (portalConfig.switching) {

        var logSystem = 'Switching';
        var logComponent = 'Setup';
        var logSubCat = 'Thread ' + (parseInt(forkId) + 1);

        var proxyState = {};

        //
        // Load proxy state for each algorithm from redis which allows NOMP to resume operation
        // on the last pool it was using when reloaded or restarted
        //
        logger.debug(logSystem, logComponent, logSubCat, 'Loading last proxy state from redis');



        /*redisClient.on('error', function(err){
            logger.debug(logSystem, logComponent, logSubCat, 'Pool configuration failed: ' + err);
        });*/

        redisClient.hgetall("proxyState", function(error, obj) {
            if (error || obj == null) {
                //logger.debug(logSystem, logComponent, logSubCat, 'No last proxy state found in redis');
            }
            else {
                proxyState = obj;
                logger.debug(logSystem, logComponent, logSubCat, 'Last proxy state loaded from redis');
            }

            //
            // Setup proxySwitch object to control proxy operations from configuration and any restored
            // state.  Each algorithm has a listening port, current coin name, and an active pool to
            // which traffic is directed when activated in the config.
            //
            // In addition, the proxy config also takes diff and varDiff parmeters the override the
            // defaults for the standard config of the coin.
            //
            Object.keys(portalConfig.switching).forEach(function(switchName) {

                var algorithm = portalConfig.switching[switchName].algorithm;

                if (portalConfig.switching[switchName].enabled === true) {
                    var initalPool = proxyState.hasOwnProperty(algorithm) ? proxyState[algorithm] : _this.getFirstPoolForAlgorithm(algorithm);
                    proxySwitch[switchName] = {
                        algorithm: algorithm,
                        ports: portalConfig.switching[switchName].ports,
                        currentPool: initalPool,
                        servers: []
                    };


                    // Copy diff and vardiff configuation into pools that match our algorithm so the stratum server can pick them up
                    //
                    // Note: This seems a bit wonky and brittle - better if proxy just used the diff config of the port it was
                    // routed into instead.
                    //
                    /*if (portalConfig.proxy[algorithm].hasOwnProperty('varDiff')) {
                        proxySwitch[algorithm].varDiff = new Stratum.varDiff(proxySwitch[algorithm].port, portalConfig.proxy[algorithm].varDiff);
                        proxySwitch[algorithm].diff = portalConfig.proxy[algorithm].diff;
                    }*/



                    Object.keys(pools).forEach(function (coinName) {
                        var p = pools[coinName];
                        if (poolConfigs[coinName].coin.algorithm === algorithm) {
                            for (var port in portalConfig.switching[switchName].ports) {
                                if (portalConfig.switching[switchName].ports[port].vardiff)
                                    p.setVarDiff(port, portalConfig.switching[switchName].ports[port].vardiff);
                            }
                        }
                    });


                    Object.keys(proxySwitch[switchName].ports).forEach(function(port){
                        var f = net.createServer(function(socket) {
                            var currentPool = proxySwitch[switchName].currentPool;

                            logger.debug(logSystem, 'Connect', logSubCat, 'Connection to '
                                + switchName + ' from '
                                + socket.remoteAddress + ' on '
                                + port + ' routing to ' + currentPool);

                            pools[currentPool].getStratumServer().handleNewClient(socket);

                        }).listen(parseInt(port), function() {
                            logger.debug(logSystem, logComponent, logSubCat, 'Switching "' + switchName
                                + '" listening for ' + algorithm
                                + ' on port ' + port
                                + ' into ' + proxySwitch[switchName].currentPool);
                        });
                        proxySwitch[switchName].servers.push(f);
                    });


                }
                else {
                    //logger.debug(logSystem, logComponent, logSubCat, 'Proxy pool for ' + algorithm + ' disabled.');
                }
            });
        });
    }

    this.getFirstPoolForAlgorithm = function(algorithm) {
        var foundCoin = "";
        Object.keys(poolConfigs).forEach(function(coinName) {
            if (poolConfigs[coinName].coin.algorithm == algorithm) {
                if (foundCoin === "")
                    foundCoin = coinName;
            }
        });
        return foundCoin;
    };
};
