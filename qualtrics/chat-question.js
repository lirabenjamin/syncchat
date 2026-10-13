// syncchat: paste into the JavaScript of a Qualtrics question (Text/Graphic type) whose
// question text (HTML view) is:  <div id="chat-root"></div>
// Edit the two settings below. Everything else can stay as is.
Qualtrics.SurveyEngine.addOnload(function () {
    var qEngine = this;

    // 1. Your deployed app URL (no trailing slash).
    var CHAT_URL = "https://YOUR-APP.onrender.com";

    // 2. URL parameters to send. Keys must match study.yaml (participant.id_param,
    //    participant.condition_param, and participant.fields). Values use Qualtrics piped text.
    var PARAMS = {
        id:    "${e://Field/ResponseID}",
        cond:  "${e://Field/cond}",
        party: "${e://Field/party}",
        top3:  "${e://Field/top3}",
        age:   "${e://Field/age}"
    };

    qEngine.hideNextButton();
    var query = Object.keys(PARAMS).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(PARAMS[k]);
    }).join("&");

    var root = document.getElementById("chat-root");
    root.innerHTML = '<iframe id="syncchat-frame" src="' + CHAT_URL + '/?' + query + '" ' +
        'style="width:100%;height:70vh;min-height:520px;border:1px solid #e4e7eb;border-radius:12px;" ' +
        'allow="clipboard-write"></iframe>';
    Qualtrics.SurveyEngine.setEmbeddedData("chat_start_ts", String(Date.now()));

    var chatOrigin = new URL(CHAT_URL).origin;
    var set = function (k, v) {
        if (v !== undefined && v !== null) {
            Qualtrics.SurveyEngine.setEmbeddedData(k, typeof v === "object" ? JSON.stringify(v) : String(v));
        }
    };

    window.addEventListener("message", function (evt) {
        // Only trust messages from the chat app.
        if (evt.origin !== chatOrigin || !evt.data || evt.data.source !== "syncchat") return;
        var d = evt.data;
        if (d.type === "chat_matched") {
            set("chat_match_id", d.match_id);
            set("chat_reveal", d.reveal);
            set("chat_waited_ms", d.waited_ms);
        } else if (d.type === "chat_ended" || d.type === "nomatch") {
            set("chat_outcome", d.outcome);          // completed | partner_left | nomatch | error
            set("chat_match_id", d.match_id);
            set("chat_message_count", d.message_count);
            set("chat_met_min_messages", d.met_min_messages);
            set("chat_waited_ms", d.waited_ms);
            set("chat_transcript", d.transcript);    // only if embed.send_transcript_to_parent: true
            set("chat_end_ts", Date.now());
            qEngine.showNextButton();
        } else if (d.type === "chat_continue") {
            qEngine.clickNextButton();
        }
    });
});
