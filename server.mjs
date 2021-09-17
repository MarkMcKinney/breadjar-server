import { createRequire } from 'module'
const require = createRequire(import.meta.url);
const env = require('dotenv').config()
import urlExist from "url-exist"
const open = require('open');
const querystring = require("querystring")
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const sassMiddleware = require('node-sass-middleware')
const app = express();

app.use(
  session({
  secret: env.parsed.SESSIONKEY,
  saveUninitialized: false,
  resave: false
  })
);

app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});
app.set('view engine', 'ejs');

import path from 'path';
const __dirname = path.resolve();
 app.use(
      sassMiddleware({
         src: __dirname + "/", //where the sass files are 
         dest: __dirname + "/", //where css should go
         debug: true // obvious
     })
 );
app.use('/public', express.static(path.join(__dirname, 'public')));

const axios = require('axios')
const { MongoClient } = require('mongodb');
const uri = "mongodb+srv://" + env.parsed.MONGOUSER + ":" + querystring.escape(env.parsed.MONGOPASSWORD) + "@" + env.parsed.MONGOCLUSTER + "?writeConcern=majority";
const mongodbset = env.parsed.MONGODBSET;
const mongocollectionset = env.parsed.MONGOCOLLECTIONSET;
const mongoconnectclient = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

// Github App Data
const clientID = env.parsed.GITHUBCLIENTID
const clientSecret = env.parsed.GITHUBCLIENTSECRET

// Generate random ID
let guid = () => {
  let s4 = () => {
      return Math.floor((1 + Math.random()) * 0x10000)
          .toString(16)
          .substring(1);
  }
  //return id of format 'aaaaaaaa'-'aaaa'-'aaaa'-'aaaa'-'aaaaaaaaaaaa'
  return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}

/*

User Setup

*/
app.get('/', function(req, res) {
  res.render('pages/index',{client_id: clientID});
});


/*

Declare the callback route

*/
app.get('/github/callback', (req, res) => {

  // The req.query object has the query params that were sent to this route.
  const requestToken = req.query.code
  
  axios({
    method: 'post',
    url: `https://github.com/login/oauth/access_token?client_id=${clientID}&client_secret=${clientSecret}&code=${requestToken}`,
    // Set the content type header, so that we get the response in JSON
    headers: {
         accept: 'application/json'
    }
  }).then((response) => {
    req.session.access_token = response.data.access_token
    res.redirect('/success');
  })
})


/*

Check for notifications (read or create new)

*/
app.get('/notifications', function(req, res) {

  var mark_read = req.query.msgid
  var send_new = req.query.create

  // Make sure user has GitHub connected
  if (req.session.access_token !== undefined && req.session.access_token !== ' ' && req.session.access_token !== '') {

    axios({
      method: 'get',
      url: `https://api.github.com/user`,
      headers: {
        Authorization: 'token ' + req.session.access_token
      }
    }).then((response) => {
      
      async function run() {
    
          await mongoconnectclient.connect();
          const database = mongoconnectclient.db(mongodbset);
          const collection = database.collection(mongocollectionset);
          var findExistingUser = await collection.find({ gitUser: response.data.login }).limit(1).toArray();

          // Read Notifications
          if (findExistingUser.length == 1) {
            res.end(JSON.stringify(findExistingUser[0]['notifications']));
          }

          // Get prevTipTime
          var lastTipTime = findExistingUser[0]['prevTipTime'];

          // Send new notification for completed payment
          if (send_new != undefined && send_new != "") {
            var timeSeconds = new Date().getTime() / 1000;

            // Prevent notification spam
            if (lastTipTime != "") {
              // If the user hasn't tipped in the last 10 minutes, send a notification
              if ((timeSeconds - lastTipTime) >= (60 * 10)) {
                await collection.updateOne({ gitUser: req.session.tip_receiver_gh }, { $push: { notifications: { from: response.data.login, msg: "Tipped you for your commit #" + req.session.tip_commit_id + " on " + req.session.tip_project, id: guid() } }});

              }
            }
            // If this is the first tip from the user, send a notification
            if (lastTipTime == "") {
              await collection.updateOne({ gitUser: req.session.tip_receiver_gh }, { $push: { notifications: { from: response.data.login, msg: "Tipped you for your commit #" + req.session.tip_commit_id + " on " + req.session.tip_project, id: guid() } }});
            }

            await collection.updateOne({ gitUser: req.session.tip_receiver_gh }, { $push: { tipsReceived: { from: response.data.login, commit: req.session.tip_commit_id, project: req.session.tip_project, desc: req.session.tip_commit_desc } }});
            await collection.updateOne({ gitUser: response.data.login }, { $push: { tipsGiven: { to: req.session.tip_receiver_gh, commit: req.session.tip_commit_id, project: req.session.tip_project, desc: req.session.tip_commit_desc } }});
            await collection.updateOne({ gitUser: response.data.login }, { $set: { prevTipTime: timeSeconds }});
            req.session.tip_receiver_gh = undefined;
            req.session.tip_commit_id = undefined;
            req.session.tip_commit_desc = undefined;
            req.session.tip_project = undefined;
          }

          // Delete notification
          if (mark_read != undefined && mark_read != "") {
            await collection.updateOne({ gitUser: response.data.login }, { $pull: { notifications: { id: mark_read } }})
          }
        }
      run().catch(console.dir);
    });
  }
  else {
    res.end(JSON.stringify([]));
  }
});


/*

Session is running successfully

*/
app.get('/success', function(req, res) {

  if (req.session.access_token !== undefined && req.session.access_token !== ' ' && req.session.access_token !== '') {

    axios({
      method: 'get',
      url: `https://api.github.com/user`,
      headers: {
        Authorization: 'token ' + req.session.access_token
      }
    }).then((response) => {

      async function run() {

        console.log("Running /success profile data collection...")

          await mongoconnectclient.connect();
          const database = mongoconnectclient.db(mongodbset);
          const collection = database.collection(mongocollectionset);
          var findExistingUser = await collection.find({ gitUser: response.data.login }).limit(1).toArray();

          if (findExistingUser.length == 0) {
                console.log("Creating new user...");
                async function createNewAccount() {
                  const newAccount = { gitUser: response.data.login, tipURL: "", prevTipTime: "", tipsGiven: [], tipsReceived: [], bmcClicks: 0, notifications: [{from: "BreadJar", msg: "Welcome to BreadJar", id: "00001"}] };
                  const mdb_result = await collection.insertOne(newAccount);
                  console.log(`User was added: ` + mdb_result);
                }
                createNewAccount().catch(console.dir);
          }

          var findExistingUser = await collection.find({ gitUser: response.data.login }).limit(1).toArray();
          await mongoconnectclient.close();

          var set_redirectURL = false;

          // Check if account access is overriding redirect
          if (req.query.o == undefined) {
            console.log("o is not defined..."); 
            // Check if BMC URL is established with account already
            if (findExistingUser[0]['tipURL'] == "" || findExistingUser[0]['tipURL'] == " ") {
              console.log("No tipURL connected...");
              // If user was trying tip, open success with notification
              if (req.session.tip_receiver_gh != undefined || req.session.tip_commit_id != undefined || req.session.tip_commit_desc != undefined || req.session.tip_project != undefined) {
                console.log("Tip check 1...");
                if (req.session.tip_receiver_gh != "" || req.session.tip_commit_id != "" || req.session.tip_commit_desc != "" || req.session.tip_project != "") {
                  console.log("Tip check 2 + redirectURL...");
                  set_redirectURL =  "/tip/" + req.session.tip_receiver_gh + "?commit=" + req.session.tip_commit_id + "&description=" + encodeURIComponent(req.session.tip_commit_desc) + "&project=" + encodeURIComponent(req.session.tip_project);

                }
              }

              res.render('pages/success',{ userData: response.data, tipURL: findExistingUser[0]['tipURL'], bmcClicks: findExistingUser[0]['bmcClicks'], redirectURL: set_redirectURL, tipsGiven: findExistingUser[0]['tipsGiven'], tipsReceived: findExistingUser[0]['tipsReceived'] });
            }
            else {
              console.log("tipURL IS connected...");
              if (req.session.tip_receiver_gh != undefined || req.session.tip_commit_id != undefined || req.session.tip_commit_desc != undefined || req.session.tip_project != undefined) {
                if (req.session.tip_receiver_gh != "" || req.session.tip_commit_id != "" || req.session.tip_commit_desc != "" || req.session.tip_project != "") {
                  console.log("Opening tip...");
                  res.redirect("/tip/"+ req.session.tip_receiver_gh + "?commit=" + req.session.tip_commit_id + "&description=" + encodeURIComponent(req.session.tip_commit_desc) + "&project=" + encodeURIComponent(req.session.tip_project));
                }
                else {
                  console.log("Only directing to success 1...");
                  res.render('pages/success',{ userData: response.data, tipURL: findExistingUser[0]['tipURL'], bmcClicks: findExistingUser[0]['bmcClicks'], redirectURL: false, tipsGiven: findExistingUser[0]['tipsGiven'], tipsReceived: findExistingUser[0]['tipsReceived']  });
                }
              }
              else {
                console.log("Only directing to success 2...");
                res.render('pages/success',{ userData: response.data, tipURL: findExistingUser[0]['tipURL'], bmcClicks: findExistingUser[0]['bmcClicks'], redirectURL: false, tipsGiven: findExistingUser[0]['tipsGiven'], tipsReceived: findExistingUser[0]['tipsReceived']  });
              }
            }
          }
          else {
            console.log("o was defined...");
            res.render('pages/success',{ userData: response.data, tipURL: findExistingUser[0]['tipURL'], bmcClicks: findExistingUser[0]['bmcClicks'], redirectURL: false, tipsGiven: findExistingUser[0]['tipsGiven'], tipsReceived: findExistingUser[0]['tipsReceived']  });
          }
      }
      run().catch(console.dir);
    }).catch(
      function (error) {
        console.log('/success ERROR:' + error.message)
        if (error.message.indexOf("401") !== -1) {
          res.redirect("https://github.com/login/oauth/authorize?client_id=" + clientID)
        }
        else {
          res.end(JSON.stringify({ errors :error.message }))
        }
      })
  }
  else {
    res.redirect("https://github.com/login/oauth/authorize?client_id=" + clientID)
  }
});


/*

User wants to change tip URL

*/
app.get('/account/tipurl', function (req, res) {
  
  // Get new URL to change
  const newtipurl = decodeURIComponent(req.query.newtipurl);
  console.log(newtipurl)

  if (req.session.access_token !== undefined && req.session.access_token !== ' ' && req.session.access_token !== '') {

    // Make sure URL isn't empty or undefined and is from buymeacoffee
    if (newtipurl != "" && newtipurl != " " && newtipurl != undefined) {

      // Check if URL exists
      async function checkUrlExist () {
        var urlReal = await urlExist("https://buymeacoffee.com/" + newtipurl)
        console.log(urlReal)

        // Make sure url is a real address
        if (urlReal == true) {
          axios({
            method: 'get',
            url: `https://api.github.com/user`,
            headers: {
              Authorization: 'token ' + req.session.access_token
            }
          }).then((response) => {

            // Change MongoDB value
            async function changeTipURL() {

              await mongoconnectclient.connect();
              const database = mongoconnectclient.db(mongodbset);
              const collection = database.collection(mongocollectionset);

              try {

                // Update tipURL key
                const result = await collection.updateOne( { gitUser: response.data.login }, { $set: { tipURL: newtipurl } })

                // If change is successful...
                if (result.acknowledged == true) {
                  res.end(JSON.stringify({ success : true }))
                }

                // if change is unsuccessful
                else {
                  res.end(JSON.stringify({ success : false, errors : "Unable to update tip URL." }))             
                }
                  } finally {
                    await mongoconnectclient.close();
                  }
              }
              changeTipURL().catch(console.dir);
            })
        }
      else {
          if (urlReal != true) {
            res.end(JSON.stringify({ success : false, errors : "Must be a valid URL." }))       
          }
          else {
            res.end(JSON.stringify({ success : false, errors : "URL cannot be empty." }))
          }
        }
      }
      checkUrlExist().catch(console.dir);
    }
  }
});


/*

User wants to make a tip

*/
app.get('/tip/:uid', function (req, res) {

  // Check for receiver GitHub username
  req.session.tip_receiver_gh = req.params.uid

  // Get commit ID
  req.session.tip_commit_id = req.query.commit

  // Get project name
  req.session.tip_project = decodeURIComponent(req.query.project)

  // Get project description
  req.session.tip_commit_desc = decodeURIComponent(req.query.description)

  var error_array = []

  // Check if variables have data/exist
  if (req.session.tip_receiver_gh == undefined || req.session.tip_commit_id == undefined || req.session.tip_commit_desc == undefined || req.session.tip_project == undefined) { 
    error_array.push("All required variables must be defined.")
  }

  if ( req.session.access_token !== undefined && req.session.access_token !== ' ' && req.session.access_token !== '') {

    // Connect to Github
    axios({
        method: 'get',
        url: `https://api.github.com/user`,
        headers: {
          Authorization: 'token ' + req.session.access_token
        }
      }).then((response) => {


        // Get BMC URL
        async function getBMCUrl() {

          await mongoconnectclient.connect();
          const database = mongoconnectclient.db(mongodbset);
          const collection = database.collection(mongocollectionset);
          var findExistingUser = await collection.find({ gitUser: req.session.tip_receiver_gh }).limit(1).toArray();
          if (findExistingUser[0] != undefined) {
            var bmcUrl = findExistingUser[0]['tipURL']

            await collection.updateOne({ gitUser: req.session.tip_receiver_gh }, { $inc: { bmcClicks: 1 } })
          
            // Redirect
            if (error_array.length < 1) {

              // Redirect to a page for user to be contacted about getting BMC set up
              if (bmcUrl == "" || bmcUrl == " ") {
                res.render('pages/invite',{ ghUser: req.session.tip_receiver_gh, tip_project: req.session.tip_project });
              }
              else {
              res.redirect("https://www.buymeacoffee.com/" + bmcUrl);
              }
            }
            else {
                res.end(JSON.stringify({ errors : error_array}))
            }
          }
          else {
            res.render('pages/invite',{ ghUser: req.session.tip_receiver_gh, tip_project: req.session.tip_project });
          }
        }
        getBMCUrl().catch(console.dir);
    }).catch(
      function (error) {
        console.log('/tip ERROR:' + error.message)
        if (error.message.indexOf("401") !== -1) {
          res.redirect("https://github.com/login/oauth/authorize?client_id=" + clientID)
        }
        else {
          res.end(JSON.stringify({ errors :error.message }))
        }
      })
  }
  else {
    res.redirect("https://github.com/login/oauth/authorize?client_id=" + clientID)
  }
 })
 

 app.listen(process.env.PORT || 80, function(){
  console.log("Express server listening on port %d in %s mode", this.address().port, app.settings.env);
});