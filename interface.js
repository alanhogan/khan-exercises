/**
 * Interface glue to handle events from 'Exercises' and talk to 'Khan' or some
 * Perseus object, whichever is appropriate for the current exercise.
 *
 * In general, khan-exercises and perseus will want to trigger events on
 * Exercises but only listen to their own events.
 */
(function() {

// If any of these properties have already been defined, then leave them --
// this happens in local mode
_.defaults(Exercises, {
    khanExercisesUrlBase: "/khan-exercises/",

    getCurrentFramework: function(userExerciseOverride) {
        return (userExerciseOverride || userExercise).exerciseModel.fileName ?
            "khan-exercises" : "perseus";
    }
});

_.extend(Exercises, {
    guessLog: undefined,
    userActivityLog: undefined
});

// The iOS app doesn't use cookies, so we need to send this as an oauth request
// (while letting the webapp send its AJAX request as before).
$.kaOauthAjax = function (options) {
    if ($.oauth) {
        return $.oauth(options);
    } else {
        return $.ajax(options);
    }
};

var PerseusBridge = Exercises.PerseusBridge,

    EMPTY_MESSAGE = $._("It looks like you haven't answered all of the " +
        "question yet."),

    // Store these here so that they're hard to change after the fact via
    // bookmarklet, etc.
    localMode = Exercises.localMode,
    previewingItem,

    originalCheckAnswerText,

    userExercise,
    problemNum,

    canAttempt,
    hintsAreFree,
    attempts,
    numHints,
    hintsUsed,
    lastAttemptOrHint,
    lastAttemptContent;

$(Exercises)
    .bind("problemTemplateRendered", problemTemplateRendered)
    .bind("newProblem", newProblem)
    .bind("hintShown", onHintShown)
    .bind("readyForNextProblem", readyForNextProblem)
    .bind("warning", warning)
    .bind("upcomingExercise", upcomingExercise)
    .bind("gotoNextProblem", gotoNextProblem)
    .bind("updateUserExercise", updateUserExercise)
    .bind("subhintExpand", subhintExpand)
    .bind("clearExistingProblem", clearExistingProblem)
    .bind("showOptOut", showOptOut);


function problemTemplateRendered() {
    previewingItem = Exercises.previewingItem;
    // Setup appropriate img URLs
    $("#issue-throbber").attr("src",
            Exercises.khanExercisesUrlBase + "css/images/throbber.gif");

    $("#positive-reinforcement").hide();
    if (localMode) {
        // The /khan-exercises/images/ folder isn't available in GAE prod so
        // don't change the src there, even though it would kind of work.
        $("#positive-reinforcement > img").attr("src",
                Exercises.khanExercisesUrlBase + "images/face-smiley.png");
    }

    // 'Check Answer' or 'Submit Answer'
    originalCheckAnswerText = $("#check-answer-button").val();

    // Solution submission
    $("#check-answer-button").click(handleCheckAnswer);
    $("#answerform").submit(handleCheckAnswer);
    $("#skip-question-button").click(handleSkippedQuestion);
    $("#opt-out-button").click(handleOptOut);

    // Hint button
    $("#hint").click(onHintButtonClicked);

    // Worked example button
    $("#worked-example-button").click(onShowExampleClicked);

    // Next question button
    $("#next-question-button").click(function() {
        $(Exercises).trigger("gotoNextProblem");

        // Disable next question button until next time
        // TODO(alpert): Why? Is blurring not enough?
        $(this)
            .attr("disabled", true)
            .addClass("buttonDisabled");
    });

    // If happy face is clicked, pass click on through.
    $("#positive-reinforcement").click(function() {
        $("#next-question-button").click();
    });

    // Let users close the warning bar when appropriate
    $("#warning-bar-close a").click(function(e) {
        e.preventDefault();
        $("#warning-bar").fadeOut("slow");
    });

    // Scratchpad toggle
    $("#scratchpad-show").click(function(e) {
        e.preventDefault();
        Khan.scratchpad.toggle();

        if (!localMode && userExercise.user) {
            LocalStore.set("scratchpad:" + userExercise.user,
                    Khan.scratchpad.isVisible());
        }
    });

    // These shouldn't interfere...
    $(PerseusBridge).trigger("problemTemplateRendered");
    $(Khan).trigger("problemTemplateRendered");
}

function newProblem(e, data) {
    Exercises.guessLog = [];
    Exercises.userActivityLog = [];

    canAttempt = true;
    hintsAreFree = false;
    attempts = data.userExercise ? data.userExercise.lastAttemptNumber : 0;
    numHints = data.numHints;
    hintsUsed = data.userExercise ? data.userExercise.lastCountHints : 0;
    lastAttemptOrHint = new Date().getTime();
    lastAttemptContent = null;

    var framework = Exercises.getCurrentFramework();
    $("#problem-and-answer")
            .removeClass("framework-khan-exercises")
            .removeClass("framework-perseus")
            .addClass("framework-" + framework);

    // Enable/disable the get hint button
    $(".hint-box").toggle(numHints !== 0);
    updateHintButtonText();
    $("#hint").attr("disabled", hintsUsed >= numHints);
    enableCheckAnswer();

    if (typeof KA !== "undefined" && KA.language === "en-PT" &&
            previewingItem) {
        // On translate.ka.org when previewing the exercise, we want to open up
        // all the hints to make it easy to translate immediately.
        while (hintsUsed < numHints) {
            onHintButtonClicked();
        }
    }

    // Render related videos, unless we're on the final stage of mastery.
    if (Exercises.RelatedVideos && data.userExercise) {
        var userExercise = data.userExercise;
        var nearMastery = userExercise.exerciseProgress.level === "mastery2" ||
                userExercise.exerciseProgress.level === "mastery3";
        var task = Exercises.learningTask;
        var hideRelatedVideos = task && task.isMasteryTask() && nearMastery;
        var relatedVideos = data.userExercise.exerciseModel.relatedVideos;

        // We have per-problem-type related videos for Perseus
        if (framework === "perseus") {
            var problemTypeName = PerseusBridge.getSeedInfo().problem_type;

            // Filter out related videos that correspond to other problem types
            var problemTypes = data.userExercise.exerciseModel.problemTypes;
            var otherProblemTypes = _.filter(problemTypes, function(type) {
                return type.name !== problemTypeName;
            });
            relatedVideos = _.filter(relatedVideos, function(video) {
                return _.all(otherProblemTypes, function(problemType) {
                    // Note: we have to cast IDs to strings for backwards
                    // compatability as older videos have pure integer IDs.
                    var stringIDs = _.map(problemType.relatedVideos,
                        function(id) {
                            return "" + id;
                        });
                    return !_.contains(stringIDs, "" + video.id);
                });
            });
        }

        if (hideRelatedVideos) {
            Exercises.RelatedVideos.render([]);
        } else {
            Exercises.RelatedVideos.render(relatedVideos);
        }
    }
}

function handleCheckAnswer() {
    return handleAttempt({skipped: false});
}

function handleSkippedQuestion() {
    return handleAttempt({skipped: true});
}

function handleOptOut() {
    Exercises.AssessmentQueue.end();
    return handleAttempt({skipped: true, optOut: true});
}

function handleAttempt(data) {
    var framework = Exercises.getCurrentFramework();
    var skipped = data.skipped;
    var optOut = data.optOut;
    var score;

    if (framework === "perseus") {
        score = PerseusBridge.scoreInput();
    } else if (framework === "khan-exercises") {
        score = Khan.scoreInput();
    }

    if (!canAttempt) {
        // Just don't allow further submissions once a correct answer or skip
        // has been called or sometimes the server gets confused.
        return false;
    }

    var isAnswerEmpty = score.empty && !skipped;
    var attemptMessage = null;

    // Is there a message to be shown?
    if (score.message != null) {
        attemptMessage = score.message;
    } else if (isAnswerEmpty) {
        attemptMessage = EMPTY_MESSAGE;
    }

    if (attemptMessage) {
        $("#check-answer-results > p").html(attemptMessage).show().tex();
        $(Exercises).trigger("attemptMessageShown", attemptMessage);
    } else {
        $("#check-answer-results > p").hide();
    }

    // Stop if the user didn't try to skip the question and also didn't yet
    // enter a response
    if (isAnswerEmpty) {
        return false;
    }

    if (score.correct || skipped) {
        // Once we receive a correct answer or a skip, that's it; further
        // attempts are disallowed.
        canAttempt = false;
    }

    var curTime = new Date().getTime();
    var millisTaken = curTime - lastAttemptOrHint;
    var timeTaken = Math.round(millisTaken / 1000);
    var stringifiedGuess = JSON.stringify(score.guess);

    lastAttemptOrHint = curTime;

    // If user hasn't changed their answer and is resubmitting w/in one second
    // of last attempt, don't allow this attempt. They're probably just
    // smashing Enter.
    if (!skipped &&
            stringifiedGuess === lastAttemptContent && millisTaken < 1000) {
        return false;
    }
    lastAttemptContent = stringifiedGuess;

    Exercises.guessLog.push(score.guess);
    Exercises.userActivityLog.push([
            score.correct ? "correct-activity" : "incorrect-activity",
            stringifiedGuess, timeTaken]);

    if (score.correct) {
        $(Exercises).trigger("problemDone", {
            card: Exercises.currentCard,
            attempts: attempts
        });
    }

    $(Exercises).trigger("checkAnswer", {
        correct: score.correct,
        card: Exercises.currentCard,
        optOut: optOut,
        // Determine if this attempt qualifies as fast completion
        fast: !localMode && userExercise.secondsPerFastProblem >= timeTaken
    });

    // Update interface corresponding to correctness
    if (skipped || Exercises.assessmentMode) {
        disableCheckAnswer();
    } else if (score.correct) {
        // Correct answer, so show the next question button.
        $("#check-answer-button").hide();
        var nextButtonText;
        if (Exercises.learningTask &&  Exercises.learningTask.isComplete()) {
            nextButtonText = $._("Awesome! Show points...");
        } else {
            nextButtonText = $._("Correct! Next question...");
        }

        $("#next-question-button")
            .prop("disabled", false)
            .removeClass("buttonDisabled")
            .val(nextButtonText)
            .show()
            .focus();
        $("#positive-reinforcement").show();
        $("#skip-question-button").prop("disabled", true);
        $("#opt-out-button").prop("disabled", true);
    } else {
        // Wrong answer. Enable all the input elements

        $("#check-answer-button")
            .parent()  // .check-answer-wrapper makes shake behave
            .effect("shake", {times: 3, distance: 5}, 480)
            .val($._("Try Again"));

        if (framework === "perseus") {
            // TODO(alpert)?
        } else if (framework === "khan-exercises") {
            $(Khan).trigger("refocusSolutionInput");
        }
    }

    if (!hintsAreFree) {
        hintsAreFree = true;
        $(".hint-box")
            .css("position", "relative")
            .animate({top: -10}, 250)
            .find(".info-box-header")
                .slideUp(250)
                .end()
            .find("#hint")
                .removeClass("orange")
                .addClass("green");
        updateHintButtonText();
    }

    if (localMode || Exercises.currentCard.get("preview")) {
        // Skip the server; just pretend we have success
        return false;
    }

    if (previewingItem) {
        $("#next-question-button").prop("disabled", true);

        // Skip the server; just pretend we have success
        return false;
    }

    // This needs to be after all updates to Exercises.currentCard (such as the
    // "problemDone" event) or it will send incorrect data to the server
    var attemptData = buildAttemptData(
            score.correct, ++attempts, stringifiedGuess, timeTaken, skipped,
            optOut);

    // Save the problem results to the server
    var requestUrl = "problems/" + problemNum + "/attempt";
    request(requestUrl, attemptData).fail(function(xhr) {
        // Alert any listeners of the error before reload
        $(Exercises).trigger("attemptError");

        if (xhr && xhr.readyState === 0) {
            // This path gets called when there is a broken pipe during
            // page unload- browser navigating away during ajax request
            // See http://stackoverflow.com/a/1370383.
            return;
        }

        // Error during submit. Disable the page and ask users to
        // reload in an attempt to get updated data.

        // Hide the page so users don't continue, then warn the user about the
        // problem and encourage reloading the page
        $("#problem-and-answer").css("visibility", "hidden");
        $(Exercises).trigger("warning",
                $._("This page is out of date. You need to " +
                    "<a href='%(refresh)s'>refresh</a>, but don't " +
                    "worry, you haven't lost progress. If you think " +
                    "this is a mistake, " +
                    "<a href='http://www.khanacademy.org/reportissue?" +
                    "type=Defect'>tell us</a>.",
                    {refresh: _.escape(window.location.href)}
                )
        );
    });

    if (skipped && !Exercises.assessmentMode) {
        // Skipping should pull up the next card immediately - but, if we're in
        // assessment mode, we don't know what the next card will be yet, so
        // wait for the special assessment mode triggers to fire instead.
        $(Exercises).trigger("gotoNextProblem");
    }

    if (Exercises.assessmentMode) {
        // Tell the assessment queue that the current question has been
        // answered so that it can serve up the next question when its ready
        // Set a small timeout to give the browser a chance to show the
        // disabled check-answer button.  Otherwise in chrome it doesn't show
        // Please wait...
        setTimeout(function() {
            Exercises.AssessmentQueue.answered(score.correct);
        },10);
    }
    return false;
}

/**
 * Handle the even when a user wants to see a worked example.
 * Currently only works on some Perseus problems.
 */
function onShowExampleClicked() {
    $(PerseusBridge).trigger("showWorkedExample");
}

var waitingOnHintRequest = false;
/**
 * Handle the event when a user clicks to use a hint.
 *
 * This deals with the internal work to do things like sending the event up
 * to the server, as well as triggering the external event "hintUsed" so that
 * other parts of the UI may update first. It's separated into two events so
 * that the XHR can be sent after the other items have a chance to respond.
 */
function onHintButtonClicked() {
    if (waitingOnHintRequest) {
        return;
    }
    waitingOnHintRequest = true;

    var curTime = new Date().getTime();
    var prevLastAttemptOrHint = lastAttemptOrHint;
    var timeTaken = Math.round((curTime - lastAttemptOrHint) / 1000);
    lastAttemptOrHint = curTime;
    var logEntry = ["hint-activity", "0", timeTaken];
    Exercises.userActivityLog.push(logEntry);

    var hintRequest;
    if (!previewingItem && !localMode && !userExercise.readOnly &&
            !Exercises.currentCard.get("preview") && canAttempt) {

        // buildAttemptData reads the number of hints we have taken from hintsUsed.
        // However, we haven't updated that yet since we haven't gotten a response
        // back, from, you guessed it, this request itself. So we increment
        // hintsUsed while forming this request so that it gets the number of hints
        // that will have been used when this request returns successfully.
        hintsUsed++;
        hintRequest = request("problems/" + problemNum + "/hint",
                buildAttemptData(false, attempts, "hint", timeTaken, false, false));
        hintsUsed--;
    } else {
        // We don't send a request to the server, so just assume immediate
        // success
        hintRequest = $.when();
    }

    // If the hint request fails within TIMEOUT_MS, it probably means that the
    // student's internet is offline and that maybe they're trying to cheat. To
    // prevent this, we always wait TIMEOUT_MS before showing a hint; if the
    // network request fails before the timeout we don't show the hint and
    // pretend that nothing happened.
    var TIMEOUT_MS = 50;
    var showHintD = $.Deferred();

    hintRequest.then(function() {
        if (showHintD.state() === "pending") {
            showHintD.resolve();
        }
    }, function() {
        if (showHintD.state() === "pending") {
            showHintD.reject();
        }
    });

    // Always show the hint after TIMEOUT_MS
    setTimeout(function() {
        if (showHintD.state() === "pending") {
            showHintD.resolve();
        }
    }, TIMEOUT_MS);

    showHintD.always(function() {
        waitingOnHintRequest = false;
    }).done(function() {
        var framework = Exercises.getCurrentFramework();
        if (framework === "perseus") {
            $(PerseusBridge).trigger("showHint");
        } else if (framework === "khan-exercises") {
            $(Khan).trigger("showHint");
        }
    }).fail(function() {
        KhanUtil.debugLog("Hint network request failed; not showing hint");
        // Set global state back to how it was
        // TODO(alpert): Really we should store this in a snapshottable way
        // (e.g., with persistent data structures) so that this is easy...
        lastAttemptOrHint = prevLastAttemptOrHint;
        // Filter out the hint activity entry in place
        var ual = Exercises.userActivityLog;
        for (var i = ual.length; i-- > 0;) {
            if (ual[i] === logEntry) {
                ual.splice(i, 1);
            }
        }
    });
}

function onHintShown(e, data) {
    // Grow the scratchpad to cover the new hint
    Khan.scratchpad.resize();

    hintsUsed++;
    updateHintButtonText();

    $(Exercises).trigger("hintUsed", data);
    // If there aren't any more hints, disable the get hint button
    if (hintsUsed === numHints) {
        $("#hint").attr("disabled", true);
    }

    // When a hint is shown, clear the "last attempt content" that is used to
    // detect duplicate, repeated attempts. Once the user clicks on a hint, we
    // consider their next attempt to be unique and legitimate even if it's the
    // same answer they attempted previously.
    lastAttemptContent = null;
}

function updateHintButtonText() {
    var $hintButton = $("#hint");
    var hintsLeft = numHints - hintsUsed;

    if (hintsAreFree) {
        $hintButton.val(hintsUsed ?
                $._("Show next hint (%(hintsLeft)s left)", {hintsLeft: hintsLeft}) :
                $._("Show hints (%(hintsLeft)s available)", {hintsLeft: hintsLeft}));
    } else {
        $hintButton.val(hintsUsed ?
                $.ngettext("I'd like another hint (1 hint left)",
                           "I'd like another hint (%(num)s hints left)",
                           hintsLeft) :
                $._("I'd like a hint"));
    }
}

// Build the data to pass to the server
function buildAttemptData(correct, attemptNum, attemptContent, timeTaken,
                          skipped, optOut) {
    var framework = Exercises.getCurrentFramework();
    var data;

    if (framework === "perseus") {
        data = PerseusBridge.getSeedInfo();
    } else if (framework === "khan-exercises") {
        data = Khan.getSeedInfo();
    }

    _.extend(data, {
        // Ask for camel casing in returned response
        casing: "camel",

        // Whether we're moving to the next problem (i.e., correctness)
        complete: correct ? 1 : 0,

        count_hints: hintsUsed,
        time_taken: timeTaken,

        // How many times the problem was attempted
        attempt_number: attemptNum,

        // The answer the user gave
        attempt_content: attemptContent,

        // If working in the context of a LearningTask (on the new learning
        // dashboard), supply the task ID.
        // TODOX(laura): The web view in the iOS app doesn't have a learningTask
        // object on Exercises. To simplify this line, add getTaskId to
        // Exercises on the webapp as well.
        task_id: (Exercises.getTaskId && Exercises.getTaskId()) ||
                (Exercises.learningTask && Exercises.learningTask.get("id")),

        user_mission_id: Exercises.userMissionId,

        // The current card data
        card: JSON.stringify(Exercises.currentCard),

        // The current topic, if any
        topic_slug: Exercises.topic && Exercises.topic.get("slug"),

        // The user assessment key if in assessmentMode
        user_assessment_key: Exercises.userAssessmentKey,

        // Whether the user is skipping the question
        skipped: skipped ? 1 : 0,

        // Whether the user is opting out of the task
        opt_out: optOut ? 1 : 0
    });

    return data;
}


var attemptHintQueue = jQuery({});

// If there are any requests left in the queue when the window unloads then we
// will have permanently lost their answers and will need to clear the session
// cache, to make sure we don't override what is passed down from the servers
$(window).unload(function() {
    if (attemptHintQueue.queue().length) {
        $(Exercises).trigger("attemptError");
    }
});

function request(method, data) {
    var apiBaseUrl = (Exercises.assessmentMode ?
            "/api/v1/user/assessment/exercises" : "/api/v1/user/exercises");

    var params = {
        // Do a request to the server API
        url: apiBaseUrl + "/" + userExercise.exerciseModel.name + "/" + method,
        type: "POST",
        data: data,
        dataType: "json"
    };

    var deferred = $.Deferred();

    attemptHintQueue.queue(function(next) {
        $.kaOauthAjax(params).then(function(data, textStatus, jqXHR) {
            deferred.resolve(data, textStatus, jqXHR);

            // Tell any listeners that we now have new userExercise data
            $(Exercises).trigger("updateUserExercise", {
                userExercise: data,
                source: "serverResponse"
            });
        }, function(jqXHR, textStatus, errorThrown) {
            // Execute passed error function first in case it wants different
            // behavior depending upon the length of the request queue
            // TODO(alpert): Huh? Don't think this matters.
            deferred.reject(jqXHR, textStatus, errorThrown);

            // Clear the queue so we don't spit out a bunch of queued up
            // requests after the error
            attemptHintQueue.clearQueue();
        }).always(function() {
            $(Exercises).trigger("apiRequestEnded");
            next();
        });
    });

    // Trigger an apiRequestStarted event here, and not in the queued function
    // because listeners should know an API request is waiting as soon as it
    // gets queued up.
    $(Exercises).trigger("apiRequestStarted");

    return deferred.promise();
}


function readyForNextProblem(e, data) {
    userExercise = data.userExercise;
    problemNum = userExercise.totalDone + 1;

    $(Exercises).trigger("updateUserExercise", {userExercise: userExercise});

    // (framework depends on userExercise set above)
    var framework = Exercises.getCurrentFramework();
    if (framework === "perseus") {
        $(PerseusBridge).trigger("readyForNextProblem", data);
    } else if (framework === "khan-exercises") {
        $(Khan).trigger("readyForNextProblem", data);
    }
}

function warning(e, message, showClose) {
    $(function() {
        var warningBar = $("#warning-bar");
        $("#warning-bar-content").html(message);
        if (showClose) {
            warningBar.addClass("warning")
                  .children("#warning-bar-close").show();
        } else {
            warningBar.addClass("error")
                  .children("#warning-bar-close").hide();
        }
        warningBar.fadeIn("fast");
    });
}

function upcomingExercise(e, data) {
    var framework = Exercises.getCurrentFramework(data.userExercise);
    if (framework === "perseus") {
        $(PerseusBridge).trigger("upcomingExercise", data);
    } else if (framework === "khan-exercises") {
        $(Khan).trigger("upcomingExercise", data);
    }
}


function gotoNextProblem() {
    var framework = Exercises.getCurrentFramework();
    if (framework === "perseus") {
        // TODO(alpert)
    } else if (framework === "khan-exercises") {
        $(Khan).trigger("gotoNextProblem");
    }
}

function updateUserExercise(e, data) {
    var framework = Exercises.getCurrentFramework();
    if (framework === "perseus") {
        // TODO(alpert)
    } else if (framework === "khan-exercises") {
        $(Khan).trigger("updateUserExercise", data);
    }
}

function showOptOut() {
    $("#opt-out-button").show();
}

function enableCheckAnswer() {
    $("#check-answer-button")
        .prop("disabled", false)
        .removeClass("buttonDisabled")
        .val(originalCheckAnswerText);

    $("#skip-question-button")
        .prop("disabled", false)
        .removeClass("buttonDisabled");

    $("#opt-out-button")
        .prop("disabled", false)
        .removeClass("buttonDisabled");
}

function disableCheckAnswer() {
    $("#check-answer-button")
        .prop("disabled", true)
        .addClass("buttonDisabled")
        .val($._("Please wait..."));

    $("#skip-question-button")
        .prop("disabled", true)
        .addClass("buttonDisabled");

    $("#opt-out-button")
        .prop("disabled", true)
        .addClass("buttonDisabled");
}

function subhintExpand(e, subhintName) {
    // write to KALOG capturing the subhint-expand
    // click
    if (!localMode) {
        $.post("/api/v1/misc/subhint_expand", {
            subhintName: subhintName
        });
    }
}

function clearExistingProblem() {
    $("#happy").hide();
    if (!$("#examples-show").data("show")) {
        // TODO(alpert): What does this do?
        $("#examples-show").click();
    }

    // Toggle the navigation buttons
    $("#check-answer-button").show();
    $("#next-question-button").blur().hide();
    $("#positive-reinforcement").hide();

    // Wipe out any previous problem
    PerseusBridge.cleanupProblem() || Khan.cleanupProblem();
    $("#workarea, #hintsarea, #solutionarea").empty();

    // Take off the event handlers for disabling check answer; we'll rebind
    // if we actually want them
    $("#solutionarea").off(".emptyAnswer");

    // Restore the hint button's original appearance
    $("#hint")
        .removeClass("green")
        .addClass("orange")
        .val($._("I'd like a hint"))
        .data("buttonText", false)
        .appendTo("#get-hint-button-container");
    $(".hint-box")
        .css("top", 0)
        .find(".info-box-header")
            .show();

    Khan.scratchpad.clear();
}

})();
