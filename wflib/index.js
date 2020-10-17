/* HyperFlow workflow engine
 ** API over redis-backed workflow instance
 ** Author: Bartosz Balis (2013-2019)
 */
var fs = require('fs'),
    redis = require('redis'),
    async = require('async'),
    ZSchema = require('z-schema'),
    value = require('value'),
    request = require('request'),
    Q = require('q'),
    pathTool = require('path'),
    //toobusy = require('toobusy'),
    shortid = require('shortid'),
    Mustache = require('mustache'),
    RemoteJobConnector = require('./connector'),
    rcl;


// for profiling
var fetchInputsTime = 0;
var sendSignalTime = 0;


var global_hfid = 0; // global UUID of this HF engine instance (used for logging)
var globalInfo = {}; // object holding global information for a given HF engine instance

let jobConnectors = {}; // object holding remote jobs' connectors

function p0() {
    return (new Date()).getTime();
}

function p1(start, name) {
    var end = (new Date()).getTime();
    console.log(name, "TOOK", end - start + "ms");
    return end;
}

exports.init = function(redisClient) {
    // FIXME: only this module should have a connection to redis. Currently app.js creates
    // the client which has to be passed around other modules. (For testing purposes
    // optional passing of client could be possible);
    if (redisClient) {
      rcl = redisClient;
      if (global_hfid == 0) {
        global_hfid = shortid.generate();

        // this object holds global information about this HF engine instance
        // written to redis as a hash map with key "hflow:<uuid>"
        // TODO: add more attributes
        globalInfo.hf_version = "???";

        rcl.hmset("hflow:"+global_hfid, globalInfo, function(err, ret) { });
      }
    }

    console.log("hfid:", global_hfid);
    /*rcl.on("error", function (err) {
      console.log("redis error: " + err);
      });*/

    //////////////////////////////////////////////////////////////////////////
    ///////////////////////// public functions ///////////////////////////////
    //////////////////////////////////////////////////////////////////////////

    function public_createInstanceFromFile(filename, baseUrl, config, cb) {
        fs.readFile(filename, 'utf8', function(err, data) {
            if (err) { return cb(err); }
            var start = (new Date()).getTime(), finish;

            // 1. render '{{var}}' variables in the workflow file
            var renderedWf=data;
            if (config.vars) {
                renderedWf = Mustache.render(data, config.vars);
                //onsole.log(renderedWf);
            }
            // 2. parse workflow to JSON
            var wfJson = JSON.parse(renderedWf);
            public_createInstance(wfJson, baseUrl, function(err, wfId) {
                finish = (new Date()).getTime();
                console.log("createInstance time: "+(finish-start)+"ms");
                err ? cb(err): cb(null, wfId, wfJson);
            });
        });
    }

    // creates a new workflow instance from its JSON representation
    function public_createInstance(wfJson, baseUrl, cb) {
        var wfId, procs, sigs, funs, schemas, ins, outs;
        var start, finish;
        //var recoveryMode = false;

        // preprocessing: converts signal names to array indexes, etc.
        var preprocess = function() {

            var sigKeys = {};

            var convertSigNames = function(sigArray) {
                for (var i in sigArray) {
                    var sigId = sigArray[i];
                    if (value(sigId).typeOf(String)) {
                        if (sigKeys[sigId].length != 1) {
                            throw new Error("Error parsing workflow (signal name=" + sigId +
                                    "). Signal names must be unique when used in 'ins' and 'outs' arrays.");
                        }
                        sigArray[i] = sigKeys[sigId][0];
                    }
                }
            }

            // both "processes" and "tasks" (old) are allowed as a name for array of processes
            procs = wfJson.processes ? wfJson.processes: wfJson.tasks;
            // both "signals" and "data" (old) are allowed as a name of array of signals
            sigs = wfJson.signals ? wfJson.signals: wfJson.data;
            funs = wfJson.functions;
            schemas = wfJson.schemas;
            ins = wfJson.ins;
            outs = wfJson.outs;

            // create a map: sigName => sigIndexes
            for (var i=0; i<sigs.length; ++i) {
                var sigName = sigs[i].name;
                if (sigKeys[sigName])
                    sigKeys[sigName].push(i); // TODO: here throw exception to enforce unique names
                else
                    sigKeys[sigName] = [i];
            }

            // extract signal counts and set proc.fullInfo.{incounts,outcounts} objects
            // as follows (example): { '1': '3', '2': 'id:4' }, which means:
            // - signal with id '1' has count 3
            // - signal with id '2' has count associated with a count signal with id 4
            // For output signal counts only the 'id:xxx' variant is valid (of course)
            var incounts = {}, outcounts = {};
            for (var i in procs) {
                for (var j in procs[i].ins) {
                    if (value(procs[i].ins[j]).typeOf(String)) {
                        var sig = procs[i].ins[j].split(":");
                        if (sig.length > 1) { // there is a 'count' modifier
                            procs[i].ins[j] = sig[0];
                            var sigId = +sigKeys[sig[0]][0]+1;
                            if (parseInt(sig[1])) { // count is a number
                                sig[1] = +sig[1];
                                //onsole.log(sigId, "COUNT IS A NUMBER:", sig[1]);
                                if (sig[1] != 1) {
                                    incounts[+sigId] = +sig[1];
                                }
                            } else { // count isn't a number, then it must be a signal name
                                if (!(sig[1] in sigKeys) || sigs[sigKeys[sig[1]][0]].control != "count") {
                                    throw(new Error("Signal count modifier in '" + procs[i].outs[j] +
                                                "' for process '" + procs[i].name +
                                                "' must be a valid control signal name."));
                                }
                                var sigCountId = +sigKeys[sig[1]][0]+1;
                                if (!incounts.rev)
                                    incounts.rev = {};
                                incounts.rev[+sigCountId] = +sigId; // reverse map (sigCountId => sigId)
                                incounts[+sigId] = "id:"+sigCountId; // this count will be set dynamically by the count signal
                                procs[i].ins.push(sig[1]); // add the signal to the list of process' inputs
                            }
                        }
                    }
                }
                //onsole.log("INCOUNTS", incounts);
                //onsole.log("PROC", +i+1, "INS", procs[i].ins);
                for (var j in procs[i].outs) {
                    if (value(procs[i].outs[j]).typeOf(String)) {
                        var sig = procs[i].outs[j].split(":");
                        if (sig.length > 1) { // there is a 'count' modifier
                            if (!(sig[1] in sigKeys) || sigs[sigKeys[sig[1]][0]].control != "count") {
                                throw(new Error("Signal count modifier in '" + procs[i].outs[j] + "' for process '" +
                                            procs[i].name + "' must be a valid control signal name."));
                            }
                            procs[i].outs[j] = sig[0];
                            procs[i].outs.push(sig[1]); // add the 'count' signal to process outputs (FIXME: it could result in duplicate signal id if the signal already was on the list -- this should be no harm because of utilizing redis sets; however -- there is also the score)
                            var sigId = +sigKeys[sig[0]][0]+1,
                                sigCountId = +sigKeys[sig[1]][0]+1;
                            outcounts[+sigId] = "id:"+sigCountId;
                        }
                    }
                }
                //onsole.log("PROC", +i+1, "OUTS", procs[i].outs);

                if (Object.keys(incounts).length) {
                    procs[i].incounts = incounts;
                }
                if (Object.keys(outcounts).length) {
                    procs[i].outcounts = outcounts;
                }
            }
            //onsole.log(" INCOUNTS: ", incounts);
            //onsole.log("OUTCOUNTS: ", outcounts);

            // convert process' ins, outs and sticky arrays
            for (var i in procs) {
                convertSigNames(procs[i].ins)
                convertSigNames(procs[i].outs)
                convertSigNames(procs[i].sticky)
            }

            // convert workflow ins and outs
            convertSigNames(ins);
            convertSigNames(outs);
        }

        var createWfInstance = function(cb) {
            var wfname = wfJson.name;
            var baseUri = baseUrl + '/apps/' + wfId;
            var wfKey = "wf:"+wfId;
            rcl.hmset(wfKey, "uri", baseUri,
                    "status", "waiting",
                    function(err, ret) { });

            jobConnectors[wfId] = new RemoteJobConnector(rcl, wfId, 3000);
            jobConnectors[wfId].run();

           var multi = rcl.multi(); // FIXME: change this to async.parallel

            var addSigInfo = function(sigId) {
                var score = -1;
                var sigObj = sigs[sigId-1];
                //sigObj.status = "not_ready"; // FIXME: remove (deprecated)
                sigKey = wfKey+":data:"+sigId;
                if (sigObj.control) { // this is a control signal
                    sigObj.type = "control";
                    delete sigObj.control; // FIXME: unify json & redis representation of control sigs
                    score = 2;
                } else {              // this is a data signal
                    score = 0;
                }
                // FIXME: signal uri removed temporarily (currently unused)
                //sigObj.uri = baseUri + '/sigs/' + sigId;

                if (sigObj.schema && value(sigObj.schema).typeOf(Object)) { // this is an inline schema
                    //onsole.log("INLINE SCHEMA", sigObj.schema);
                    var schemasKey = wfKey + ":schemas";
                    var schemaField = "$inline$"+sigId; // give a name to the schema, and save it to a hash
                    multi.hset(schemasKey, schemaField, JSON.stringify(sigObj.schema), function(err, ret) { });
                    sigObj.schema = schemaField;
                }

                if (sigObj.data) { // signal info also contains its instance(s) (initial signals to the workflow)
                    // add signal instance(s) to a special hash
                    multi.hset(wfKey + ":initialsigs", sigId, JSON.stringify(sigObj),
                            function(err, ret) { });
                    delete sigObj.data; // don't store instances in signal info
                }

                if (sigObj.remoteSinks) { // signal info contains URIs to remote sinks
                    sigObj.remoteSinks.forEach(function(sink) {
                        multi.sadd(sigKey+":remotesinks", sink.uri, function(err, ret) { });
                    });
                    sigObj.remoteSinks = true; // don't store remote sinks URIs in sig info, just a flag
                }

                // create a reverse index to look up sig Id by its name (assumes unique names!)
                multi.hset(wfKey+":siglookup:name", sigObj.name, sigId, function(err, ret) { });

                multi.hmset(sigKey, sigObj, function(err, ret) { });

                // add this signal id to the sorted set of all workflow signals
                // score determines the type/status of the signal:
                // 0: data signal/not ready, 1: data signal/ready, 2: control signal
                // FIXME: score deprecated
                multi.zadd(wfKey+":data", score, sigId, function(err, ret) { });
            }

            // add workflow processes
            var procKey;
            for (var i=0; i<procs.length; ++i) {
                var procId = i+1, uri;
                if (procs[i].host) { // FIXME: host deprecated (replaced by remote sinks)
                    uri = procs[i].host + '/apps/' + wfId;
                } else {
                    uri = baseUri;
                }
                procKey = wfKey+":task:"+procId;
                processProc(procs[i], wfname, uri, wfKey, procKey, procId, function() { });
            }

            // add signal schemas
            if (wfJson.schemas) {
                var schemasKey = wfKey + ":schemas";
                //onsole.log(wfJson.schemas);
                for (var sKey in wfJson.schemas) {
                    //onsole.log("ADDING SCHEMA", sKey, wfJson.schemas[sKey]);
                    multi.hset(schemasKey, sKey, JSON.stringify(wfJson.schemas[sKey]), function(err, ret) { });
                }
            }

            var dataKey;
            // add information about workflow data and control signals
            for (var i=0; i<sigs.length; ++i) {
                addSigInfo(i+1);
            }

            // add workflow inputs and outputs
            for (var i=0; i<wfJson.ins.length; ++i) {
                (function(inId, dataId) {
                    multi.zadd(wfKey+":ins", inId, dataId, function(err, rep) { });
                })(i+1, wfJson.ins[i]+1);
            }
            for (var i=0; i<wfJson.outs.length; ++i) {
                (function(outId, dataId) {
                    multi.zadd(wfKey+":outs", outId, dataId, function(err, rep) { });
                })(i+1, wfJson.outs[i]+1);
            }
            // register workflow functions
            for (var i in wfJson.functions) {
                multi.hset("wf:"+wfId+":functions:"+wfJson.functions[i].name, "module",
                        wfJson.functions[i].module, function(err, rep) { });
            }

            multi.exec(function(err, replies) {
                console.log('Done processing workflow JSON.');
                cb(err);
            });
        }

        var processProc = function(task, wfname, baseUri, wfKey, procKey, procId, cb) {
            // TODO: here there could be a validation of the process, e.g. Foreach process
            // should have the same number of ins and outs, etc.
            var multi=rcl.multi();

            var taskObject = function(task) {
                var copy = {};
                if (null == task || value(task).notTypeOf(Object)) return task;
                for (var attr in task) {
                    if (task.hasOwnProperty(attr)) {
                        if (value(task[attr]).typeOf(Object)) {
                            copy[attr] = JSON.stringify(task[attr]);
                        } else if (value(task[attr]).typeOf(Array)) {
                            copy[attr] = task[attr].length; // arrays are not stored, just their length!
                        } else {
                            copy[attr] = task[attr];
                        }
                    }
                }
                copy.fun = task.function ? task.function: "null"; // FIXME: unify this attr name
                copy.wfname = wfname || "null";
                /*if (!copy.config)
                    copy.config = "null";*/
                copy.status = "waiting";
                return copy;
            }

            multi.hmset(procKey, taskObject(task), function(err, ret) { });

            // FIXME: "task" type deprecated, change the default type to "dataflow"
            // add task id to sorted set of all wf tasks. Score 0/1/2==waiting/running/finished
            // FIXME: score is now deprecated
            task.type = task.type ? task.type.toLowerCase() : "task";
            multi.zadd(wfKey+":tasks", 0 /* score */, procId, function(err, ret) { });

            // For every task of type other than "task" (e.g. "foreach", "choice"), add its
            // id to a type set.
            // Engine uses this to know which FSM instance to create
            // TODO: need additional, "global" set with all possible task type names
            if (task.type != "task") {
                multi.sadd(wfKey+":tasktype:"+task.type, procId);
            }

            // add process inputs and outputs + signals sources and sinks
            for (var i=0; i<task.ins.length; ++i) {
                let inId = i+1;
                let dataId = task.ins[i]+1;
                var dataKey = wfKey+":data:"+dataId;
                //console.log("inId", inId, "dataId", dataId)
                multi.zadd(procKey+":ins", inId, dataId, function(err, rep) { });
                multi.zadd(dataKey+":sinks", inId /* score: port id */ , procId, function(err, ret) { });
                if (sigs[dataId-1].control) { // add all control inputs to a separate hash
                    //multi.hmset(procKey+":cins", sigs[dataId-1].control, dataId);
                    multi.hmset(procKey+":cins", dataId, sigs[dataId-1].control);
                    multi.sadd(procKey+":cinset", dataId);
                }
            }
            for (var i=0; i<task.outs.length; ++i) {
                let outId = i+1;
                let dataId = task.outs[i]+1;
                var dataKey = wfKey+":data:"+dataId;
                multi.zadd(procKey+":outs", outId, dataId, function(err, rep) { });
                multi.zadd(dataKey+":sources", outId /* score: port Id */, procId, function(err, ret) { });
                if (sigs[dataId-1].control) { // add all control outputs to a separate hash
                    multi.hmset(procKey+":couts", sigs[dataId-1].control, dataId);
                    multi.sadd(procKey+":coutset", dataId);
                }
            }

            // add info about input and output counts
            for (var sig in task.incounts) {
                (function(s, c) {
                    if (s == "rev") {
                        c = JSON.stringify(c);
                    }
                    multi.hset(procKey+":incounts", s, c);
                })(sig, task.incounts[sig])
            }
            for (var sig in task.outcounts) {
                (function(s, c) {
                    multi.hset(procKey+":outcounts", s, c);
                })(sig, task.outcounts[sig])
            }

            // add info on which input ports (if any) are "sticky"
            if (!task.sticky) task.sticky = [];
            for (var i=0; i<task.sticky.length; ++i) {
                (function(sigId) {
                    //onsole.log("STICKY ADDING", sigId);
                    rcl.sadd(procKey+":sticky", sigId, function(err, res) { });
                })(task.sticky[i]+1);
            }

            multi.exec(function(err, replies) {
                cb();
            });
        }

        rcl.incrby("wfglobal:nextId", 1, function(err, ret) {
            if (err) { throw err; }

            // FIXME: "setnx" should be done synchronously, before moving to createWfInstance
            // (but a race is probably impossible such that "recoveryMode" is set incorrectly)
            // FIXME: probably to be removed, recovery mode will be set via option to 'hflow'
            // NOTE: we probably don't need persistent IDs because there are no persistent objects:
            //       we recover state of the workflow which is no longer needed after the workflow
            //       is finished executing. (IOW, workflow apps are different than business apps)
            /*if (wfJson.persistenceId) {
                rcl.setnx("wftrace:" + wfJson.persistenceId, "1", function(err, ret) {
                    console.log(err, ret);
                    if (ret == 0) { // the persistence key already exists in redis --- we go to recovery mode
                        recoveryMode = true;
                    }
                });
            }*/

            wfId = ret.toString();
            preprocess();
            createWfInstance(function(err) {
                cb(null, wfId); // FIXME: is race with 'setnx' above impossible? (EDIT: pending removal)
            });
        });
    }


    // returns a list of tasks with ids within [from..to], and their ins and outs
    function public_getWfTasks(wfId, from, to, cb) {
        rcl.zcard("wf:"+wfId+":data", function(err, ret) {
            var dataNum = ret;
            if (to < 0) {
                rcl.zcard("wf:"+wfId+":tasks", function(err, ret) {
                    if (err) return cb(err);
                    var to1 = ret+to+1;
                    //onsole.log("From: "+from+", to: "+to1);
                    getTasks1(wfId, from, to1, dataNum, cb);
                });
            }  else {
                getTasks1(wfId, from, to, dataNum, cb);
            }
        });
    }

    // returns list of URIs of instances, ...
    // TODO
    function public_getWfInfo(wfName, cb) {
        cb(null, []);
    }

    // returns a JSON object with fields uri, status, nTasks, nData
    // FIXME: currently also returns nextTaskId, nextDataId
    function public_getWfInstanceInfo(wfId, cb) {
        var multi = rcl.multi();
        multi.zcard("wf:"+wfId+":tasks", function(err, ret) { });
        multi.zcard("wf:"+wfId+":data", function(err, ret) { });
        multi.hgetall("wf:"+wfId, function(err, ret) { });
        multi.exec(function(err, replies) {
            if (err) {
                cb(err);
            } else {
                replies[2].nTasks = replies[0];
                replies[2].nData = replies[1];
                cb(null, replies[2]);
            }
        });
    }

    function public_setWfInstanceState(wfId, obj, cb) {
        rcl.hmset("wf:"+wfId, obj, function(err, rep) {
            cb(err, rep);
        });
    }

    function public_getWfIns(wfId, withports, cb) {
        if (withports) {
            rcl.zrangebyscore("wf:"+wfId+":ins", 0, "+inf", "withscores", function(err, ret) {
                err ? cb(err): cb(null, ret);
            });
        } else {
            rcl.zrangebyscore("wf:"+wfId+":ins", 0, "+inf", function(err, ret) {
                err ? cb(err): cb(null, ret);
            });
        }
    }

    function public_getWfOuts(wfId, withports, cb) {
        if (withports) {
            rcl.zrangebyscore("wf:"+wfId+":outs", 0, "+inf", "withscores", function(err, ret) {
                err ? cb(err): cb(null, ret);
            });
        } else {
            rcl.zrangebyscore("wf:"+wfId+":outs", 0, "+inf", function(err, ret) {
                err ? cb(err): cb(null, ret);
            });
        }
    }

    function public_getWfInsAndOutsInfoFull(wfId, cb) {
        var multi = rcl.multi();
        var ins = [], outs = [];

        multi.zrangebyscore("wf:"+wfId+":ins", 0, "+inf", function(err, ret) {
            ins = err ? err: ret;
        });
        rcl.zrangebyscore("wf:"+wfId+":outs", 0, "+inf", function(err, ret) {
            outs = err ? err: ret;
        });

        multi.exec(function(err, replies) {
            if (err) { return cb(err); }
            for (var i=0; i<ins.length; ++i) {
                (function(i) {
                    var dataKey = "wf:"+wfId+":data:"+ins[i];
                    multi.hmget(dataKey, "uri", "name", "status", function(err, reply) {
                        ins[i] = err ? err: {"uri": reply[0], "name": reply[1], "status": reply[2]};
                    });
                })(i);
            }
            for (var i=0; i<outs.length; ++i) {
                (function(i) {
                    var dataKey = "wf:"+wfId+":data:"+outs[i];
                    multi.hmget(dataKey, "uri", "name", "status", function(err, reply) {
                        outs[i] = err ? err: {"uri": reply[0], "name": reply[1], "status": reply[2]};
                    });
                })(i);
            }

            multi.exec(function(err, replies) {
                err ? cb(err): cb(null, ins, outs);
            });
        });
    }

    function public_getTaskInfo(wfId, procId, cb) {
        var procKey = "wf:"+wfId+":task:"+procId;
        rcl.hgetall(procKey, function(err, reply) {
            err ? cb(err): cb(null, reply);
        });
    }

    function public_getTaskIns(wfId, procId, withports, cb) {
        var procKey = "wf:"+wfId+":task:"+procId;
        if (withports) {
            rcl.zrangebyscore(procKey+":ins", 0, "+inf", "withscores", function(err, ret) {
                err ? cb(err): cb(null, ret);
            });
        } else {
            rcl.zrangebyscore(procKey+":ins", 0, "+inf", function(err, ret) {
                err ? cb(err): cb(null, ret);
            });
        }
    }

    function public_getTaskOuts(wfId, procId, withports, cb) {
        var procKey = "wf:"+wfId+":task:"+procId;
        if (withports) {
            rcl.zrangebyscore(procKey+":outs", 0, "+inf", "withscores", function(err, ret) {
                err ? cb(err): cb(null, ret);
            });
        } else {
            rcl.zrangebyscore(procKey+":outs", 0, "+inf", function(err, ret) {
                err ? cb(err): cb(null, ret);
            });
        }
    }

    function pushInput(wfId, procId, sigId, sigIdx, cb) {
        var isStickyKey = "wf:"+wfId+":task:"+procId+":sticky"; // KEYS[1]
        var queueKey = "wf:"+wfId+":task:"+procId+":ins:"+sigId; // KEYS[2]

        // LUA Script
        // ARGS[1] = sigId
        // ARGS[2] = sigIdx
        var pushScript = '\
            local ret \
            if redis.call("SISMEMBER", KEYS[1], ARGV[1]) == 1 then \
                local len = redis.call("LLEN", KEYS[2]) \
                if (len > 0) then \
                    ret = redis.call("LSET", KEYS[2], ARGV[2]) \
                else \
                    ret = redis.call("RPUSH", KEYS[2], ARGV[2]) \
                end \
            else \
                ret = redis.call("RPUSH", KEYS[2], ARGV[2]) \
            end \
            return ret';

        rcl.eval([pushScript, 2, isStickyKey, queueKey, sigId, sigIdx], function(err, res) {
	    if (err) throw err;
            cb(err);
        });
        return;

        // OLD non-Lua implementation
        // checking if this input signal is on a 'sticky' port
        rcl.sismember("wf:"+wfId+":task:"+procId+":sticky", sigId, function(err, isSticky) {
            if (isSticky) {
                // if the input is 'sticky', the new signal is not queued, only replaces the old one
                // (there is no queue of signals, just the 'currrent' signal value)
                rcl.llen(queueKey, function(err, llen) {
                    if (llen) {
                        rcl.lset(queueKey, 0, sigIdx, function(err, rep) {
                            cb(err);
                        });
                    } else {
                        rcl.rpush(queueKey, sigIdx, function(err, rep) {
                            cb(err);
                        });
                    }
                    //onsole.log("STICKY PUSH sigId=", sigId, "LLEN=", llen, "Idx=", sigIdx);
                });

            } else {
                rcl.rpush(queueKey, sigIdx, function(err, rep) {
                    cb(err);
                    //rcl.llen(queueKey, function(err, llen) {
                        //onsole.log("PUSH sigId=", sigId, "LLEN=", llen, "Idx=", sigIdx);
                        //cb(err);
                    //});
                });
            }
        });
    }

    function popInput(wfId, procId, sigId, cb) {
        //onsole.log("POP INPUT", wfId, procId, sigId);
        var sigQueueKey = "wf:"+wfId+":task:"+procId+":ins:"+sigId;
        var sigInstanceKey = "wf:"+wfId+":sigs:"+sigId;
        var isStickyKey = "wf:"+wfId+":task:"+procId+":sticky";

        // LUA Script
        // KEYS[1] = sigQueueKey
        // KEYS[2] = sigInstanceKey
        // KEYS[3] = isStickyKey
        // ARGV[1] = sigId
        var popScript = '\
            local sigval \
            local idx \
            if redis.call("SISMEMBER", KEYS[3], ARGV[1]) == 1 then \
                idx = redis.call("LINDEX", KEYS[1], 0) \
                sigval = redis.call("HGET", KEYS[2], idx) \
            else \
                idx = redis.call("LPOP", KEYS[1]) \
                sigval = redis.call("HGET", KEYS[2], idx) \
            end \
            return {sigval,idx}';

        rcl.eval([popScript, 3, sigQueueKey, sigInstanceKey, isStickyKey, sigId], function(err, res) {
	    if (err) throw err;
            var sig = JSON.parse(res[0]);
            //sig.sigIdx = res[1];
            cb(err, sig);
        });
        return;

        // OLD non-Lua implementation
        // checking if this input signal is on a 'sticky' port
        rcl.sismember("wf:"+wfId+":task:"+procId+":sticky", sigId, function(err, isSticky) {
            if (isSticky) {
                //onsole.log("STICKY!", procId, sigId);
                // if the input is 'sticky', the signal is not removed, just its value is retrieved
                // (there is no queue of signals, just the 'currrent' signal value which is persistent)
                rcl.lindex(sigQueueKey, 0, function(err, sigIdx) {
                    rcl.hget(sigInstanceKey, sigIdx, function(err, sigValue) {
                        var sig = JSON.parse(sigValue);
                        //sig._id = sigId;
                        cb(err, sig);
                    });
                });
            } else {
                rcl.lpop(sigQueueKey, function(err, sigIdx) {
                    rcl.hget(sigInstanceKey, sigIdx, function(err, sigValue) {
                        var sig = JSON.parse(sigValue);
                        //sig._id = sigId;
                        cb(err, sig);
                        //rcl.hlen(sigInstanceKey, function(err, hlen) {
                         //   rcl.llen(sigQueueKey, function(err, llen) {
                                //onsole.log("sigId=", sigId, "LLEN=", llen, "HLEN=", hlen, "Idx=", sigIdx);
                                //cb(err, sig);
                            //});
                        //});
                    });
                });
            }
        });
    }

    function resetStickyPorts(wfId, procId, cb) {
        rcl.smembers("wf:"+wfId+":task:"+procId+":sticky", function(err, sigs) {
            async.each(sigs, function(sigId, cbNext) {
                var queueKey = "wf:"+wfId+":task:"+procId+":ins:"+sigId;
                rcl.lpop(queueKey, function(err, rep) {
                    rcl.llen(queueKey, function(err, len) {
                        //onsole.log(queueKey, "LEN="+len);
                        cbNext(err);
                    });
                });
            },
            function(err) {
                err ? cb(null): cb(err);
            });
        });
    }


    function public_setTaskState(wfId, procId, obj, cb) {
        rcl.hmset("wf:"+wfId+":task:"+procId, obj, function(err, rep) {
            cb(err, rep);
        });
    }

    function public_getDataInfo(wfId, dataId, cb) {
        var data, nSources, nSinks, dataKey;
        var multi = rcl.multi();

        dataKey = "wf:"+wfId+":data:"+dataId;
        procKeyPfx = "wf:"+wfId+":task:";

        // Retrieve data element info
        multi.hgetall(dataKey, function(err, reply) {
            data = err ? err: reply;
        });

        multi.zcard(dataKey+":sources", function(err, ret) {
            nSources = err ? err : ret;
        });

        multi.zcard(dataKey+":sinks", function(err, ret) {
            nSinks = err ? err : ret;
        });

        multi.exec(function(err, replies) {
            if (err) {
                cb(err);
            } else {
                data.nSources = nSources;
                data.nSinks = nSinks;
                cb(null, data);
            }
        });
    }

    // returns full data element info
    // OBSOLETED BY getSignalInfo
    function public_getDataInfoFull(wfId, dataId, cb) {
        var data, sources, sinks, dataKey, procKeyPfx, tasks = {};
        var multi = rcl.multi();

        dataKey = "wf:"+wfId+":data:"+dataId;
        procKeyPfx = "wf:"+wfId+":task:";

        // Retrieve data element info
        multi.hgetall(dataKey, function(err, reply) {
            data = err ? err: reply;
        });

        // this is a great feature: sort+get combo (even for hashes)!
        multi.sort(dataKey+":sources", "get", procKeyPfx+"*->uri",
                "get", procKeyPfx+"*->name",
                "get", procKeyPfx+"*->status",
                function(err, reply) {
                    if (err) {
                        sources = err;
                    } else {
                        sources = [];
                        for (var i=0; i<reply.length; i+=3) {
                            sources.push({"uri": reply[i], "name": reply[i+1], "status": reply[i+2]});
                        }
                        //onsole.log("sources[0]: "+sources[0]);
                    }
                });

        multi.sort(dataKey+":sinks", "get", procKeyPfx+"*->uri",
                "get", procKeyPfx+"*->name",
                "get", procKeyPfx+"*->status",
                function(err, reply) {
                    if (err) {
                        sinks = err;
                    } else {
                        sinks = [];
                        for (var i=0; i<reply.length; i+=3) {
                            sinks.push({"uri": reply[i], "name": reply[i+1], "status": reply[i+2]});
                        }
                        //onsole.log("sinks[0]: "+sinks[0]);
                    }
                });

        multi.exec(function(err, replies) {
            if (err) {
                cb(err);
            } else {
                cb(null, data, sources, sinks);
            }
        });
    }

    // given @sigs - an array of signal Ids, returns their information (metadata)
    // - @sigs: array of signal ids, e.g [1,3,7]
    // - @cb = function(err, sigInfo), where sigInfo the output array
    //   sigInfo[i] = { "_id": sigId, attr: value, attr: value, ... }
    function getSignalInfo(wfId, sigs, cb) {
        var asyncTasks = [], sigInfo = [];
        for (var i=0; i<sigs.length; ++i) {
            (function(idx) {
                asyncTasks.push(function(callback) {
                    var sigId = sigs[idx];
                    sigKey = "wf:"+wfId+":data:"+sigId;
                    rcl.hgetall(sigKey, function(err, sig) {
                        if (err || sig == -1) { callback(new Error("Redis error")); }
                        sigInfo[idx] = sig;
                        sigInfo[idx]._id = sigId;
                        sigInfo[idx].id = sigId; // FIXME compatibility with OLD API: to be removed
                        callback(null, sig);
                    });
                });
            })(i);
        }
        async.parallel(asyncTasks, function done(err, result) {
            cb(err, sigInfo);
        });
    }

    // returns sigId of signal with name 'sigName'
    function getSigByName(wfId, sigName, cb) {
        var wfKey = "wf:"+wfId;
        rcl.hget(wfKey+":siglookup:name", sigName, function(err, sigId) {
            err ? cb(err): cb(null, sigId);
        });
    }


    // checks if given input signals are ready (in the queues), and returns their values
    // @sigsSpec format: { sigId: count, sigId: count, ... }
    // @deref (boolean): if true and all sigs are ready, their values will be returned
    // @cb: function(result, [sigValues])
    //   result: true if 'count' instances of each signal 'sigId' are present in the queues
    //   sigValues (optional) format: [ [ spec[0] signal values ], [ spec[1] signal values ], ... ]
    //                       example: [ [ { name: 'filename',
    //                                      uri: '/apps/1/sigs/1',
    //                                      _id: '1',
    //                                      _ts: 415334,
    //                                      data: [ { path: 'tmp1/asynctest.js' } ]
    //                                } ] ]
    //
    // TODO: optimize by introducing a counter of how many signals await on ALL ports of a given task.
    //       often it will be enough to tell that a process is NOT ready to fire, without checking all queues
    function fetchInputs(wfId, procId, sigsSpec, deref, cb) {
        //var time = (new Date()).getTime();
        var spec = [];
        for (var i in sigsSpec)  { // TODO: rewrite the code below to use object, instead of converting to array
            spec.push([i, sigsSpec[i]]);
        }
        var sigValues = [];
        async.every(spec, function (sig, callback) {
            var queueKey = "wf:"+wfId+":task:"+procId+":ins:"+sig[0];
            rcl.llen(queueKey, function(err, len) {
                //onsole.log("FETCH SIG", sig, "LEN", len);
                callback(!err && len>=sig[1]);
            });
        }, function(result) {
            if (!result || !deref) return cb(result);
            async.times(spec.length, function(n, cbNext) {
                //sigValues[n] = [];
                async.timesSeries(spec[n][1] /* count */, function(m, cbNextInner) {
                    popInput(wfId, procId, spec[n][0] /* sigId */, function(err, sig) {
                        if (!sig.control) { // don't return values of control signals!
                            if (m==0) {
                                sigValues.push([sig]);
                            } else {
                                sigValues[sigValues.length-1].push(sig);
                            }
                        }
                        cbNextInner();
                    });
                }, function(err, res) {
                    cbNext();
                });
            }, function(err, res) {
                //time -= (new Date()).getTime();
                //onsole.log("FETCHING INPUTS FOR", procId , "TOOK", -time+"ms");
                //fetchInputsTime -= time;
                //onsole.log("CHECK INPUT DEREF:", sigValues);
                cb(result, sigValues);
            });
        });
    }

    // Change state of one or more data elements
    // - @spec: JSON object in the format:
    //   { dataId: { attr: val, attr: val}, dataId: { ... } ... }
    //   e.g. { "1": { "status": "ready", "value": "33" } ... }
    function public_setDataState(wfId, spec, cb) {
        var multi = rcl.multi(),
            notEmpty = false;
        for (var i in spec) {
            //onsole.log(i, spec[i]);
            var obj = spec[i];
            if (Object.keys(spec).length) { // spec not empty
                (function(dataId, obj) {
                    //onsole.log(dataId, obj);
                    multi.hmset("wf:"+wfId+":data:"+dataId, obj, function(err, rep) { });
                    notEmpty = true;
                })(i, obj);
            }
        }
        if (notEmpty) {
            multi.exec(function(err, reps) {
                err ? cb(err): cb(null, reps);
            });
        }
    }

    // Returns a 'map' of a workflow. Should be passed a callback:
    // function(nProcs, nData, err, ins, outs, sources, sinks, types, cPortsInfo), where:
    // - nProcs        = number of processes (also length of ins and outs arrays)
    // - nSigs         = number of data elements (also length of sources and sinks arrays)
    // - ins[i][j]     = data id mapped to j-th input port of i-th task
    // - outs[i][j]    = data id mapped to j-th output port of i-th task
    // - sources[i][1] = task id which produces data element with id=i (if none, sources[i]=[])
    // - sources[i][2] = port id in this task the data element is mapped to
    // - sinks[i][j]   = task id which consumes data element with id=i (if none, sinks[i]=[])
    // - sinks[i][j+1] = port id in this task the data element is mapped to
    // - types         = ids of tasks with type other than default "task"; format:
    //                   { "foreach": [1,2,5], "choice": [3,4] }
    // - cPortsInfo    = information about all control ports of all tasks; format:
    //                   { procId: { "ins": { portName: sigId } ... }, "outs": { ... } } }
    //                   e.g.: { '1': { ins: { next: '2' }, outs: { next: '2', done: '4' } } }
    // - fullInfo[i]   = all additional attributes of i-th task (e.g. firingInterval etc.)
function public_getWfMap(wfId, cb) {
    var asyncTasks = [];
    var wfKey = "wf:"+wfId;

    var getNumProcsAndSignals = function(cb) {
        rcl.zcard(wfKey+":tasks", function(err, nProcs) {
            if (err || nProcs == -1) { throw(new Error("Redis error")); }
            rcl.zcard(wfKey+":data", function(err, nSigs) {
                if (err || nSigs == -1) { throw(new Error("Redis error")); }
                cb(nProcs, nSigs);
            });
        });
    }

    getNumProcsAndSignals(function(nProcs, nSigs) {
        var types = {}, ins = [], outs = [], sources = [], sinks = [], cPortsInfo = {}, fullInfo = [];
        for (i=1; i<=nProcs; ++i) {
            let procId = i;
            let procKey = wfKey+":task:"+procId;
            asyncTasks.push(function(callback) {
                rcl.hgetall(procKey, function(err, taskInfo) {
                    //onsole.log("FULL TASK INFO:", taskInfo);
                    fullInfo[procId] = taskInfo;
                    // add additional info to fullInfo
                    async.parallel([
                        function(cb) {
                            if (taskInfo.sticky) {
                                var stickyKey = procKey+":sticky";
                                rcl.smembers(stickyKey, function(err, stickySigs) {
                                    if (!stickySigs) stickySigs = [];
                                    fullInfo[procId].stickySigs = {};
                                    stickySigs.forEach(function(s) {
                                        fullInfo[procId].stickySigs[+s] = true;
                                    });
                                    cb(err);
                                });
                            } else {
                                cb(null);
                            }
                        },
                        function(cb) {
                            rcl.smembers(procKey+":cinset", function(err, cins) {
                                if (!cins) cins = [];
                                fullInfo[procId].cinset = {};
                                cins.forEach(function(c) {
                                    fullInfo[procId].cinset[+c] = true;
                                });
                                cb(err);
                            });
                        },
                        function(cb) {
                            rcl.smembers(procKey+":coutset", function(err, couts) {
                                if (!couts) couts = [];
                                //onsole.log("COUTS", couts);
                                fullInfo[procId].coutset = {};
                                couts.forEach(function(c) {
                                    fullInfo[procId].coutset[+c] = true;
                                });
                                cb(err);
                            });
                        },
                        function(cb) {
                            rcl.hgetall(procKey+":incounts", function(err, incounts) {
                                if (incounts && incounts.rev) {
                                    incounts.rev = JSON.parse(incounts.rev);
                                }
                                fullInfo[procId].incounts = incounts;
                                cb(err);
                            });
                        },
                        function(cb) {
                            rcl.hgetall(procKey+":outcounts", function(err, outcounts) {
                                fullInfo[procId].outcounts = outcounts;
                                cb(err);
                            });
                        }
                    ],
                    function done(err) {
                        callback(err, taskInfo);
                    });
                });
            });
            asyncTasks.push(function(callback) {
                rcl.zrangebyscore(procKey+":ins", 0, "+inf", function(err, ret) {
                    if (err || ret == -1) { throw(new Error("Redis error")); }
                    ins[procId] = ret;
                    callback(null, ret);
                    //ins[procId].unshift(null); // inputs will be indexed from 1 instead of 0
                });
            });
            asyncTasks.push(function(callback) {
                rcl.zrangebyscore(procKey+":outs", 0, "+inf", function(err, ret) {
                    if (err || ret == -1) { throw(new Error("Redis error")); }
                    outs[procId] = ret;
                    //outs[procId].unshift(null);
                    callback(null, ret);
                });
            });
            asyncTasks.push(function(callback) {
                rcl.hgetall(procKey+":cins", function(err, csigs) {
                    //onsole.log("CSIGS INS", JSON.stringify(csigs));
                    if (err || csigs == -1) { throw(new Error("Redis error")); }
                    if (csigs != null) {
                        var tmp = {};
                        for (var s in csigs) {
                            if (tmp[csigs[s]]) {
                                tmp[csigs[s]].push(s);
                            } else {
                                tmp[csigs[s]] = [s];
                            }
                        }
                        for (var i in tmp) {
                            if (tmp[i].length == 1) {
                                tmp[i] = tmp[i][0];
                            }
                        }
                        if (!(procId in cPortsInfo)) {
                            cPortsInfo[procId] = {};
                        }
                        cPortsInfo[procId].ins = tmp;
                        //onsole.log("C PORTS INFO=", JSON.stringify(cPortsInfo));
                    }
                    callback(null, csigs);
                });
            });
            asyncTasks.push(function(callback) {
                rcl.hgetall(procKey+":couts", function(err, ret) {
                    //onsole.log("Proc COUTS WFLIB", ret);
                    if (err || ret == -1) { throw(new Error("Redis error")); }
                    if (ret != null) {
                        if (!(procId in cPortsInfo)) {
                            cPortsInfo[procId] = {};
                        }
                        cPortsInfo[procId].outs = ret;
                    }
                    callback(null, ret);
                });
            });
        }
        for (i=1; i<=nSigs; ++i) {
            let sigId = i;
            let dataKey = wfKey+":data:"+sigId;
            // info about all signal sources
            asyncTasks.push(function(callback) {
                rcl.zrangebyscore(dataKey+":sources", 0, "+inf", "withscores", function(err, ret) {
                    if (err || ret == -1) { throw(new Error("Redis error")); }
                    sources[sigId] = ret;
                    //onsole.log(sigId+";"+ret);
                    //sources[sigId].unshift(null);
                    callback(null, ret);
                });
            });
            // info about signal sinks
            /*asyncTasks.push(function(callback) {
                rcl.zrange(dataKey+":sinks", 0, -1, function(err, ret) {
                    if (err || ret == -1) { throw(new Error("Redis error")); }
                    sinks[sigId] = ret;
                    //sinks[sigId].unshift(null);
                    callback(null, ret);
                });
            });*/
        }
        // Create info about task types (all remaining tasks have the default type "task")
        // TODO: pull the list of types dynamically from redis
        asyncTasks.push(function(callback) {
            async.each(["foreach", "splitter", "csplitter", "choice", "cchoice", "dataflow", "join"],
                function iterator(type, next) {
                    rcl.smembers(wfKey+":tasktype:"+type, function(err, rep) {
                        if (err || rep == -1) { throw(new Error("Redis error")); }
                        if (rep) {
                            //onsole.log(type, rep); // DEBUG
                            types[type] = rep;
                        }
                        next();
                    });
                },
                function done(err) {
                    callback(null, types);
                }
            );
        });

        //onsole.log("async tasks: "+asyncTasks.length);
        async.parallel(asyncTasks, function done(err, result) {
            cb(null, nProcs, nSigs, ins, outs, sources, sinks, types, cPortsInfo, fullInfo);
        });
    });
}


/*
 * returns task map, e.g.:
 * ins  = [1,4] ==> input data ids
 * outs = [2,3] ==> output data ids
 * sources = { 1: [], 4: [] }
 *                      ==> which task(s) (if any) produced a given input
 * sinks   = { 2: [108,1,33,3], 3: [108,2,33,4] }
 *                      ==> which task(s) (if any) consume a given output
 *                          "108,1" means task 108, port id 1
 */
function public_getTaskMap(wfId, procId, cb) {
    var ins = [], outs = [], sources = {}, sinks = {};
    var multi = rcl.multi();
    var procKey = "wf:"+wfId+":task:"+procId;
    multi.zrangebyscore(procKey+":ins", 0, "+inf", function(err, ret) {
        ins = ret;
    });
    multi.zrangebyscore(procKey+":outs", 0, "+inf", function(err, ret) {
        outs = ret;
    });
    multi.exec(function(err, reps) {
        if (err) {
            cb(err);
        } else {
            for (var i in ins) {
                (function(i) {
                    var dataKey = "wf:"+wfId+":data:"+ins[i];
                    multi.zrangebyscore(dataKey+":sources", 0, "+inf", "withscores", function(err, ret) {
                        sources[ins[i]] = ret;
                    });
                })(i);
            }
            for (var i in outs) {
                (function(i) {
                    var dataKey = "wf:"+wfId+":data:"+outs[i];
                    multi.zrangebyscore(dataKey+":sinks", 0, "+inf", "withscores", function(err, ret) {
                        sinks[outs[i]] = ret;
                    });
                })(i);
            }
            multi.exec(function(err, reps) {
                cb(null, ins, outs, sources, sinks);
            });
        }
    });
}

function public_getDataSources(wfId, dataId, cb) {
    var dataKey = "wf:"+wfId+":data:"+dataId;
    rcl.zrangebyscore(dataKey+":sources", 0, "+inf", "withscores", function(err, ret) {
        err ? cb(err): cb(null, ret);
    });
}

// Retrieves a list of data sinks (tasks).
function public_getDataSinks(wfId, dataId, withports, cb) {
    var dataKey = "wf:"+wfId+":data:"+dataId;

    if (withports) {
        rcl.zrangebyscore(dataKey+":sinks", 0, "+inf", "withscores", function(err, ret) {
            err ? cb(err): cb(null, ret);
        });
    } else {
        rcl.zrangebyscore(dataKey+":sinks", 0, "+inf", function(err, ret) {
            err ? cb(err): cb(null, ret);
        });
    }
}


// Retrieves a list of remote data sinks (tasks). Such sinks are notified over
// HTTP using their full URI.
function public_getRemoteDataSinks(wfId, dataId, cb) {
    var replies = [], reply = [];
    var dataKey = "wf:"+wfId+":data:"+dataId;
    var multi = rcl.multi();

    rcl.zcard(dataKey+":sinks", function(err, rep) {
        // FIXME: rep is not used, multi is not executed, and there is no zrangebyscore -1 -1
        multi.zrangebyscore(dataKey+":sinks", -1, -1, "withscores", function(err, ret) {
            err ? cb(err): cb(null, ret);
        });
    });
}



/*
 * @insValues - array of input signal values as returned by fetchInputs
 * @appConfig - configuration specific for this workflow instance (the engine.config object), e.g. working directory
 */
function public_invokeProcFunction(wfId, procId, firingId, insIds_, insValues, outsIds_, emulate, eventServer, appConfig, cb) {
    function isArray(what) {
        return Object.prototype.toString.call(what) === '[object Array]';
    }

    //onsole.log("INVOKING:", insIds_, insValues);

    var insIds = [], outsIds = [];
    isArray(insIds_) ? insIds = insIds_: insIds.push(insIds_);
    isArray(outsIds_) ? outsIds = outsIds_: outsIds.push(outsIds_);

    // convert an array of signals to an object-array
    var convertSigs2ObjArray = function(sigs) {
        if (sigs == null) return null;
        function Arg() {}
        Arg.prototype = Object.create(Array.prototype);
        var outSigs = new Arg;
        sigs.forEach(function(s) {
            outSigs.push(s);
        });
        outSigs.forEach(function(s, idx) {
            outSigs[s.name] = outSigs[idx];
        });
        return outSigs;
    }

    // TODO: reuse convertSigs2ObjArray
    var convertSigValuesToFunctionInputs = function() {
        function Arg() {} // arguments will be an Array-like object
        Arg.prototype = Object.create(Array.prototype);
        var funcIns = new Arg;
        for (var i=+0; i<insIds.length; ++i) {
            funcIns.push(insValues[i][0]);
            //funcIns[i] = insValues[i][0]; // for start, copy the first signal instance
            delete funcIns[i]._ts;
            delete funcIns[i].ts;
            delete funcIns[i]._uri;
            delete funcIns[i].uri;
            delete funcIns[i].status;
            // if there were more signal instances, only copy their data
            for (var j=1; j<insValues[i].length; ++j) {
                funcIns[i].data.push(insValues[i][j].data[0]);
            }
            var sigName = funcIns[i].name; // TODO: validate names
            funcIns[sigName] = funcIns[i]; // as a result, in the function input signals can be accessed by their name or index
        }
        return funcIns;
    }

    var ins = convertSigValuesToFunctionInputs();

    // TODO: for each ins[i].data[j], create a map (i,j) => metadata (for provenance logging)
    // In functions user-defined provenance could look like:
    // - options.prov.push(["read", "foo", 0]), where "foo" is sig name, "0" is 'data' array index

    //onsole.log("FUNC INS", ins);

    public_getTaskInfo(wfId, procId, function(err, procInfo) {
        if (err) return cb(err);

        var prepareFuncOutputs = function(callback) {
            // if in recovery mode, use recovery data --> pass outputs that were produced
            // during the previous run. The function will decide if re-execution is needed.
            if (appConfig.recovery) {
                var key = procId + "_" + firingId;
                // if outputs from this firing have been persisted in the previous execution, we reuse them!
                if (key in appConfig.recoveryData.outputs) {
                    var outs = convertSigs2ObjArray(appConfig.recoveryData.outputs[key]);
                    //onsole.log("RECOVERY DATA FOUND!!!", outs);
                    return callback(outs, true);
                }
            }

            var asyncTasks = [], outsTmp = [];

            // retrieve task outputs given in 'outsIds'
            for (i=0; i<outsIds.length; ++i) {
                (function(idx) {
                    asyncTasks.push(function(callback) {
                        var dataKey = "wf:"+wfId+":data:"+outsIds[idx];
                        rcl.hgetall(dataKey, function(err, dataInfo) {
                            outsTmp[+idx] = dataInfo;
                            callback(err, dataInfo);
                        });
                    })
                })(i);
            }

            /*function Arg() {} // make 'outs' an Array-like object
            Arg.prototype = Object.create(Array.prototype);
            var outs = new Arg;*/

            async.parallel(asyncTasks, function done(err, result) {
                if (err) return cb(err);

                // convert 'outsTmp' array to array-like object 'outs'
                var outs = convertSigs2ObjArray(outsTmp);
                //console.log("OUTS", outs);

                /*for (var i=0; i<outsTmp.length; i++) {
                    outs.push(outsTmp[i]);
                    outs[outsTmp[i].name] = outs[i];
                }*/
                callback(outs, false);
            });
        }

        prepareFuncOutputs(function(outs, recovered) {
            if (emulate) {
                return setTimeout(function() {
                    cb(null, ins, outs);
                }, 100);
            }

            function hasForceRecomputeFlag() {
                var key = procId + "_" + firingId;
                var s = appConfig.recoveryData ? appConfig.recoveryData.settings: undefined;
                return s && s[key] && s[key].flags && s[key].flags.includes('forceRecompute');
            }

            // when this is a recovered firing, unless the process has set flag "executeWhenRecovering",
            // and unless "forceRecompute" flag is set in the recovery file -- this means that
            // something has changed (e.g. software version) and the task must be recomputed
            var recomputeForced = hasForceRecomputeFlag();
            if (recovered && !procInfo.executeWhenRecovering && !recomputeForced) {
                return cb(null, ins, outs, {"recovered": "true", "recomputeForced": recomputeForced });
            }

            if ((procInfo.fun == "null") || (!procInfo.fun)) {
                throw new Error("No function defined for the process." + JSON.stringify(procInfo));
            }

            /////////////////////////
            // INVOKE THE FUNCTION //
            /////////////////////////

            rcl.hgetall("wf:"+wfId+":functions:"+procInfo.fun, function(err, fun) {
                if (err) return cb(err);

                if (appConfig.workdir) {
                     process.chdir(appConfig.workdir);
                }

                // Load the function trying the following locations, in order:
                // 1) Module declared in workflow.json (if any)
                // 2) "functions.js" file in the workflow's directory
                // 3) HyperFlow core "functions" module
                var f;

                // if the function's module was declared in the workflow file -- use it
                // otherwise try "functions.js"
                var funModuleName = (fun && fun.module) ? fun.module : "functions.js";
                var funPath = pathTool.join(appConfig.workdir ? appConfig.workdir : "", funModuleName);

                if (fs.existsSync(funPath)) {
                    try {
                        f = require(funPath)[procInfo.fun];
                    } catch(err) {
                        throw err;
                    }
                } else {
                    // if the function could not be loaded, look in the core HyperFlow functions
                    funPath = pathTool.join(require('path').dirname(require.main.filename), "..", "functions");
                    f = require(funPath)[procInfo.fun];
                }

                // the function couldn't be found anywhere
                if (!f) {
                    throw(new Error("Unable to load the process function: " +
                                procInfo.fun + " in module: " + funPath + ", exception:  " + err));
                }

                //onsole.log("FUNCTION", procInfo.fun, module);
                //onsole.log("FPATH", fpath, "F", f, "FUN", procInfo.fun);
                //onsole.log("FUNCTION", procInfo.fun, module);
                //onsole.log("FPATH", fpath, "F", f, "FUN", procInfo.fun);
                //onsole.log("INS:", ins);
                //onsole.log("OUTS:", outs);
                //onsole.log(JSON.stringify(procInfo.config));  //DEBUG
                var conf = procInfo.config ? JSON.parse(procInfo.config): {};
                conf.name = procInfo.name;
                conf.appConfig = appConfig;
                //var executor = procInfo.executor ? procInfo.executor: null;

                //onsole.log("INS VALUES", insValues);
                if (eventServer !== 'undefined') {
                    conf['eventServer'] = eventServer;
                }

                // Pass identifiers to the function
                conf.hfId = global_hfid;
                conf.appId = wfId;
                conf.procId = procId;
                conf.firingId = firingId;
                // 'task' denotes a process firing/activation
                conf.taskId = conf.hfId + ":" + conf.appId + ":" + conf.procId + ":" + conf.firingId;
                conf.wfname = procInfo.wfname;

                // This function is passed to the Process' Function (through 'context')
                // and can be used to wait for task completion. It reads a key from redis
                // that should be set by the task's executor.
                // 'taskId' to be waited for is read from the process context, but
                // optionally it can be set by the caller via parameter 'taskIdentifier'
                var getJobResult = async function(timeout, taskIdentifier) {
                    const taskId = taskIdentifier || conf.taskId;
                    let wfId = taskId.split(':')[1];
                    let connector = jobConnectors[wfId];
                    return connector.waitForTask(taskId);
                }

                conf.jobResult = getJobResult;
                conf.redis_url = "redis://" + rcl.address;

                // The next two functions may be used by the job function/executor to, 
                // respectively, mark that or check if the task has been completed.
                // Useful e.g. in Kubernetes which sometimes restarts a succesfully 
                // completed job for uknown reason.
                var markTaskCompleted = async function(taskIdentifier) {
                    return new Promise(function(resolve, reject) {
                        const completedTasksSetKey = "wf:" + wfId + ":completedTasks";
                        const taskId = taskIdentifier || conf.taskId;
                        rcl.sadd(completedTasksSetKey, taskId, function(err, reply) {
                            err ? reject(err): resolve(reply);
                        });
                    });
                }
                var checkTaskCompletion = async function(taskIdentifier) {
                    return new Promise(function(resolve, reject) {
                        const completedTasksSetKey = "wf:" + wfId + ":completedTasks";
                        const taskId = taskIdentifier || conf.taskId;
                        rcl.sismember(completedTasksSetKey, taskId, function(err, hasCompleted) {
                            err ? reject(err): resolve(hasCompleted);
                        });
                    });
                }
                conf.markTaskCompleted = markTaskCompleted;
                conf.checkTaskCompletion = checkTaskCompletion;

                // This function is passed to the Process' Function (through 'context')
                // and can be used to pass a job message (via Redis) to a job executor 
                // 'taskId' to be waited for is read from the process context, but 
                // optionally it can be set by the caller via parameter 'taskIdentifier' 
                var sendMessageToJob = async function(message, taskIdentifier) {
                    return new Promise(function(resolve, reject) {
                        const taskId = taskIdentifier || conf.taskId;
                        const taskMessageKey=taskId+"_msg";
                        rcl.lpush(taskMessageKey, message, function(err, reply) {
                            err ? reject(err): resolve(reply);
                        });
                    });
                }

                conf.sendMsgToJob = sendMessageToJob;

                // Pass the workflow working directory
                if (appConfig.workdir) {
                  conf.workdir = appConfig.workdir;
                }


                if (recovered) { conf.recovered = true; }
                f(ins, outs, conf, function(err, outs, options) {
                    //if (outs) { onsole.log("VALUE="+outs[0].value); } // DEBUG
                    if (recovered) {
                        if (!options) {
                            options = { recovered: true }
                        } else {
                            options.recovered = true;
                        }
                    }
                    cb(null, ins, outs, options);
                });
            });
        });
    });
}


function getInitialSignals(wfId, cb) {
    var wfKey = "wf:"+wfId;
    rcl.hgetall(wfKey + ":initialsigs", function(err, sigs) {
        var sigSpec = [];
        for (var sigId in sigs) {
            var sig = JSON.parse(sigs[sigId]);
            delete sig._ts;
            delete sig.ts;
            delete sig._uri;
            delete sig.uri;
            delete sig.status;
            sig._id = +sigId;
            sigSpec.push(sig);
            /*sigInstances = JSON.parse(sigs[sigId]);
            for (var idx in sigInstances) {
                // FIXME: retrieve signal metadata to 's' and set 's.data = sigInstances[ids]'
                var s = sigInstances[idx];
                //onsole.log("INITIAL:", s);
                s._id = sigId;
                sigSpec.push(s);
            }*/
        }
        cb(err, sigSpec);
    });
}

function sendSignalLua(wfId, sigValue, cb) {
    var sigId = sigValue._id; // ARGV[1]
    var sigKey = "wf:"+wfId+":data:"+sigId; // KEYS[1]
    var sigInstanceKey = "wf:"+wfId+":sigs:"+sigId; // KEYS[2]
    var sigNextIdKey = "wf:"+wfId+":sigs:"+sigId+":nextId"; // KEYS[3]
    var sigSinksKey = sigKey + ":sinks"; // KEYS[4]
    var wfKey = "wf:" + wfId; // KEYS[5]
    var sig ; // ARGV[2]
    //onsole.log(sigInstanceKey);
    //onsole.log(sigNextIdKey);
    //onsole.log(sigSinksKey);
    //onsole.log(sig);

    //var time = (new Date()).getTime(); // for profiling

    var sendSignalScript = '\
        local ret \
        local sigIdx = ARGV[3] \
        redis.call("HSET", KEYS[2], sigIdx, ARGV[2]) \
        local sinks = redis.call("ZRANGE", KEYS[4], 0, -1) \
        for k,procId in pairs(sinks) do \
            local ret \
            local isStickyKey = KEYS[5] .. ":task:" .. procId .. ":sticky" \
            local sigQueueKey = KEYS[5] .. ":task:" .. procId .. ":ins:" .. ARGV[1] \
            if redis.call("SISMEMBER", isStickyKey, ARGV[1]) == 1 then \
                local len = redis.call("LLEN", sigQueueKey) \
                if (len > 0) then \
                    ret = redis.call("LSET", sigQueueKey, sigIdx) \
                else \
                    ret = redis.call("RPUSH", sigQueueKey, sigIdx) \
                end \
            else \
                ret = redis.call("RPUSH", sigQueueKey, sigIdx) \
            end \
        end \
        return sinks';

    // sigIdx = unique signal instance id
    rcl.incr("wf:"+wfId+":sigs:"+sigId+":nextId", function(err, sigIdx) {
        sigValue.sigIdx = +sigIdx;
        sig = JSON.stringify(sigValue);
        rcl.eval([sendSignalScript, 5, sigKey, sigInstanceKey, sigNextIdKey, sigSinksKey, wfKey, sigId, sig, sigIdx], function(err, res) {
            //time -= (new Date()).getTime();
            //onsole.log("SENDING SIGNAL X", sigId, "TOOK", -time+"ms");
            //sendSignalTime -= time;
            /*var delay = 0;
              if (toobusy()) { onsole.log("TOO BUSY !!!!!!!!!!!!!!!!!!!!!!!!!!"); delay = 40; }
              setTimeout(function() { cb(err, res); }, delay);*/
            if (err) throw err;

            if (sigValue.remoteSinks) {
                rcl.smembers(sigKey+":remotesinks", function(err, remoteSinks) {
                    delete sigValue.remoteSinks;
                    async.each(remoteSinks, function(sinkUri, doneIterCb) {
                        request.post({
                            headers: {'content-type' : 'application/json'},
                            url:     sinkUri,
                            json:    sigValue
                        }, function(error, response, body) {
                            if (error) console.log("ERROR", error);
                            doneIterCb();
                            //onsole.log(error);
                            //onsole.log(response);
                            //onsole.log(body);
                        });
                        //onsole.log("REMOTE SINKS: ", ret);
                    }, function doneAll(err) {
                        cb(err, res);
                    });
                });
            } else {
                cb(err, res);
            }
        });
    });
}


/*
// Part of NEW API for continuous processes with FIFO queues
// @sig format:
// ... TODO
function public_sendSignal(wfId, sig, cb) {
    //onsole.log("sendSignal:", sig);
    var sigId = sig._id;
    delete sig._id;

    var time = (new Date()).getTime();

    var validateSignal = function(cb) {
        // get signal information (metadata)
        var sigKey = "wf:"+wfId+":data:"+sigId;
        rcl.hgetall(sigKey, function(err, sigInfoStr) {
            //onsole.log('VALIDATING', typeof sig, sig, "AGAINST", typeof sigInfoStr, sigInfoStr);
            var sigInfo = sigInfoStr;
            if (err) { return cb(err, false); }
            if (!sigInfo.schema) { return cb(null, true); } // no schema to validate signal against
            rcl.hget("wf:"+wfId+":schemas", sigInfo.schema, function(err, sigSchema) { // retrieve schema
                if (err) { return cb(err, false); }
                ZSchema.validate(sig, JSON.parse(sigSchema), function(err, report) {
                    if (err) { return cb(err, false); }
                    //onsole.log("REPORT");
                    //onsole.log(sig);
                    //onsole.log(sigSchema);
                    //onsole.log(report);
                    cb(null, true);
                });
            });
        });
    }

    //////////////////////////////////////// SENDING THE SIGNAL: /////////////////////////////////////////
    // create a new instance of this signal (at hash = "wf:{id}:sigs:{sigId}", field = sig instance id) //
    // (hash is better than a list because of easier cleanup of old signals)                            //
    //////////////////////////////////////////////////////////////////////////////////////////////////////


    async.waterfall([
        // 1. validate the signal
        function(cb) {
            validateSignal(function(err, isValid) {
                cb(err);
            });
        },
        // 2. get unique id for the signal instance
        function(cb) {
            rcl.incr("wf:"+wfId+":sigs:"+sigId+":nextId", function(err, sigIdx) {
                err ? cb(err): cb(null, sigIdx);
            });
        },
        // 3. save instance of the signal to redis
        function(sigIdx, cb) {
            var idx = sigIdx.toString();
            var sigInstanceKey = "wf:"+wfId+":sigs:"+sigId;
            rcl.hset(sigInstanceKey, idx, JSON.stringify(sig), function(err, rep) {
                err ? cb(err): cb(null, idx);
            });
        },
        // 4. put the signal in the queues of all its sinks
        function(idx, cb) {
            //var s = p0();
            public_getDataSinks(wfId, sigId, false, function(err, sinks) {
                //p1(s, "GET SINKS ("+sinks.length+")");
                //var t = p0();
                //onsole.log("sendSignal: ", sigId, sinks);
                if (err) { return cb(err); }
                // insert the signal (its index in the hash) in the queues of its sinks
                //onsole.log("SINKS: ", sinks);
                async.each(sinks, function iterator(procId, doneIter) {
                    pushInput(wfId, procId, sigId, idx, function(err) {
                        doneIter(err);
                    });
                    //var queueKey = "wf:"+wfId+":task:"+procId+":ins:"+sigId;
                    //rcl.rpush(queueKey, idx, function(err, rep) {
                    //   doneIter(err);
                    //});
                }, function doneAll(err) {
                    //p1(t, "PUSH ALL SIGS");
                    err ? cb(err): cb(null, sinks);
                });
            });
        }],
        // 5. all done
        function(err, sinks) {
            time -= (new Date()).getTime();
            //onsole.log("SENDING SIGNAL Y", sigId, "TOOK", -time+"ms");
            sendSignalTime -= time;
            if (err) {
                console.log(err.toString(), err.stack);
            }
            err ? cb(err): cb(null, sinks);
        }
    );
}
*/

function getSigRemoteSinks(wfId, sigId, cb) {
    var rsKey = "wf:"+wfId+":data:"+sigId+":remotesinks";
    rcl.smembers(rsKey, function(err, ret) {
        cb(err, ret);
    });
}

// sets remote sinks for a signal
// @remoteSinks = array: [ { "uri": uri1 }, { "uri": uri2 }, ... ]
// @options = object; possible values:
//      { "replace": true }: if present, currently defined remote sinks will be replaced
//                           if not, new remote sinks will be added to existing ones
function setSigRemoteSinks(wfId, sigId, remoteSinks, options, cb) {
    var replace = options && options.replace == true,
        wfKey = "wf:"+wfId;
        sigKey = wfKey+":data:"+sigId,
        rsKey = wfKey+":data:"+sigId+":remotesinks";

    Q.fcall(function() {
        if (replace) {
            rcl.del(rsKey, function(err) {
                if (err) throw(err);
                return;
            });
        } else return;
    })
    .then(function() {
        async.eachSeries(remoteSinks, function(sink, doneIterCb) {
            rcl.sadd(rsKey, sink.uri, function(err, ret) {
                doneIterCb(err);
            });
        }, function doneAll(err) {
            if (err) throw(err);
            return;
        });
    })
    .then(function() {
        rcl.hset(sigKey, "remoteSinks", true, function(err, ret) {
            if (err) throw(err);
            return;
        });
    })
    .catch(function(error) {
        cb(error);
    })
    .done(function() {
        cb(null);
    });
}


function getStickySigs(wfId, procId, cb) {
    var stickyKey = "wf:"+wfId+":task:"+procId+":sticky";
    rcl.smembers(stickyKey, function(err, stickySigs) {
        cb(err, stickySigs);
    });
}


// checks if all signals with specified ids are ready for a given task; if so, returns their values
// @spec - array of elements: [ { "id": id, "count": count }, { "id": id, "count": count }, ... ] where
//             id    - input signal identifier for task procId
//             count - number of instances of this signal which are waited for (typically 1, but
//                     a task may also consume multiple data elements at once from a given port)
function public_getInsIfReady(wfId, procId, spec, cb) {
    async.reduce(spec, 0, function iterator(memo, sig, cbNext) {
        var queueKey = "wf:"+wfId+":task:"+procId+":ins:"+sig.id;
        rcl.llen(queueKey, function(err, len) {
            err ?  cbNext(err): cbNext(null, memo + (len == sig.count ? 1: 0));
        });
    }, function done(err, result) {
        if (err) return cb(err);
        if (result == spec.length) {
            // all signals are ready
            var queueKey = "wf:"+wfId+":task:"+procId+":ins:"+sig.id;
            // TODO: retrieve signals
            //rcl.lrange(queueKey, 0, )
        } else {
            cb(null, null);
        }
    });
}


//////////////////////////////////////////////////////////////////////////
///////////////////////// private functions //////////////////////////////
//////////////////////////////////////////////////////////////////////////

function getTasks1(wfId, from, to, dataNum, cb) {
    var tasks = [], ins = [], outs = [], data  = [];
    var asyncTasks = [];
    var start, finish;
    start = (new Date()).getTime();
    for (var i=from; i<=to; ++i) {
        // The following "push" calls need to be wrapped in an anynomous function to create
        // a separate scope for each value of "i". See http://stackoverflow.com/questions/2568966
        (function(i) {
            var procKey = "wf:"+wfId+":task:"+i;
            // Retrieve task info
            asyncTasks.push(function(callback) {
                rcl.hmget(procKey, "uri", "name", "status", "fun", function(err, reply) {
                    if (err) {
                        tasks[i-from] = err;
                        callback(err);
                    } else {
                        tasks[i-from] = {
                            "uri": reply[0],
                    "name": reply[1],
                    "status": reply[2],
                    "fun": reply[3]
                        };
                        callback(null, reply);
                    }
                });
            });

            // Retrieve all ids of inputs of the task
            asyncTasks.push(function(callback) {
                rcl.sort(procKey+":ins", function(err, reply) {
                    if (err) {
                        ins[i-from] = err;
                        callback(err);
                    } else {
                        ins[i-from] = reply;
                        callback(null, reply);
                    }
                });
            });

            // Retrieve all ids of outputs of the task
            asyncTasks.push(function(callback) {
                rcl.sort(procKey+":outs", function(err, reply) {
                    if (err) {
                        outs[i-from] = err;
                        callback(err);
                    } else {
                        outs[i-from] = reply;
                        callback(null, reply);
                    }
                });
            });

        })(i);
    }

    // Retrieve info about ALL data elements (of this wf instance).
    // FIXME: can it be done better (more efficiently)?
    // - Could be cached in node process's memory but then data may not be fresh.
    // - We could calculate which subset of data elements we need exactly but that
    //   implies additional processing and more complex data structures...
    // - MULTI instead of many parallel tasks? ==> NO, that sometimes breaks
    for (var i=1; i<=dataNum; ++i) {
        (function(i) {
            var dataKey = "wf:"+wfId+":data:"+i;
            asyncTasks.push(function(callback) {
                rcl.hmget(dataKey, "uri", "name", "status", function(err, reply) {
                    if (err) {
                        data[i] = err;
                        callback(err);
                    } else {
                        data[i] = {"uri": reply[0], "name": reply[1], "status": reply[2]};
                        callback(null, reply);
                    }
                });
            });
        })(i);
    }

    //onsole.log("async tasks: "+asyncTasks.length);

    async.parallel(asyncTasks, function done(err, result) {
        if (err) {
            cb(err);
        } else {
            finish = (new Date()).getTime();
            console.log("getTasks exec time: "+(finish-start)+"ms");

            // replace ids of data elements with their attributes
            for (var i=0; i<tasks.length; ++i) {
                for (var j=0; j<ins[i].length; ++j) {
                    ins[i][j] = data[ins[i][j]];
                }
                for (var k=0; k<outs[i].length; ++k) {
                    outs[i][k] = data[outs[i][k]];
                }
            }

            cb(null, tasks, ins, outs);
        }
    });
}


return {
    createInstance: public_createInstance,
    createInstanceFromFile: public_createInstanceFromFile,
    getWfInfo: public_getWfInfo,
    getWfInstanceInfo: public_getWfInstanceInfo,
    setWfInstanceState: public_setWfInstanceState,
    getWfTasks: public_getWfTasks,
    getWfIns: public_getWfIns,
    getWfOuts: public_getWfOuts,
    //getWfInsAndOutsInfoFull: public_getWfInsAndOutsInfoFull,
    getTaskInfo: public_getTaskInfo,
    //getTaskIns: public_getTaskIns,
    //getTaskOuts: public_getTaskOuts,
    setTaskState: public_setTaskState,
    getDataInfo: public_getDataInfo,
    getDataInfoFull: public_getDataInfoFull,
    setDataState: public_setDataState,
    getDataSources: public_getDataSources,
    getDataSinks: public_getDataSinks,
    getRemoteDataSinks: public_getRemoteDataSinks,
    getWfMap: public_getWfMap,
    getTaskMap: public_getTaskMap,
    invokeProcFunction: public_invokeProcFunction,
    //sendSignal: public_sendSignal,
    sendSignal: sendSignalLua,
    getSignalInfo: getSignalInfo,
    popInput: popInput,
    resetStickyPorts: resetStickyPorts,
    fetchInputs: fetchInputs,
    getInitialSigs: getInitialSignals,
    sendSignalLua: sendSignalLua,
    getSigByName: getSigByName,
    getSigRemoteSinks: getSigRemoteSinks,
    setSigRemoteSinks: setSigRemoteSinks,

    hfid: global_hfid
};

};


process.on('exit', function() {
    //console.log("fetchInputs total time:", fetchInputsTime/1000);
    //console.log("sendSignal total time:", sendSignalTime/1000);
});
