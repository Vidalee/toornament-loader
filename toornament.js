'use strict';

const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const r = require("rethinkdbdash")({
    port: 28015,
    host: "localhost"
});
const config = require("./config.json");

const cookies = config.cookies;
const app = require('express')();
const opn = require('opn')
const cheerio = require('cheerio')
const api_key = config.toornament_api_key;

const riot_key = config.riot_key;
const port = 3003;
const callbackUrl = 'http://localhost:3003/callback';
let token;
const { AuthorizationCode } = require('simple-oauth2');
const axios = require('axios');
const { range } = require('lodash');

const client = new AuthorizationCode(config.oauth2);

// Authorization uri definition
const authorizationUri = client.authorizeURL({
    redirect_uri: callbackUrl,
    scope: 'organizer:view organizer:result',
    state: config.state,
}).replace("oauth", "oauth2");


// Initial page redirecting to Github
app.get('/auth', (req, res) => {
    console.log(authorizationUri);
    res.redirect(authorizationUri);
});

// Callback service parsing the authorization token and asking for the access token
app.get('/callback', async(req, res) => {
    const { code } = req.query;
    const options = {
        code,
        redirect_uri: callbackUrl
    };
    console.log("code: " + code);
    try {
        const accessToken = await client.getToken(options);
        token = accessToken.token.access_token;
        console.log('The resulting token: ', accessToken.token);

        return res.status(200).json(accessToken.token);
    } catch (error) {
        console.error('Access Token Error', error);
        return res.status(500).json('Authentication failed');
    }
});

app.get('/', (req, res) => {
    res.redirect('/auth')
});


app.listen(port, (err) => {
    if (err) return console.error(err);

    console.log(`Express server listening at http://localhost:${port}`);
});


async function getTournamentInfo(tournamentId) {
    const config = {
        method: 'get',
        url: 'https://api.toornament.com/organizer/v2/tournaments/' + tournamentId,
        headers: { 'X-Api-Key': api_key, 'Authorization': 'Bearer ' + token }
    }

    try {
        const response = await axios(config);

        return response.data
    } catch (e) {
        console.log("Wrong permissions.", e);
        return;
    }
}

async function getMatches(tournamentId) {
    let array = [];
    let array_max = 1;
    let i = 0;


    //return new Promise((resolve,reject) => {})
    while (i < array_max) {
        try {
            const config = {
                method: 'get',
                url: 'https://api.toornament.com/organizer/v2/tournaments/' + tournamentId + '/matches',
                headers: { 'X-Api-Key': api_key, 'Authorization': 'Bearer ' + token, 'Range': `matches=${i}-${i + 99}` }
            }
            const response = await axios(config);
            for (let match of response.data) {
                if (match.status != 'completed')
                    continue;
                const config_games = {
                    method: 'get',
                    url: `https://api.toornament.com/organizer/v2/tournaments/${tournamentId}/matches/${match.id}/games`,
                    headers: { 'X-Api-Key': api_key, 'Authorization': 'Bearer ' + token, 'Range': `games=0-49` }
                }
                const response_games = await axios(config_games);
                match.games = response_games.data;
                array.push(match);
            }
            array_max = parseInt(response.headers['content-range'].split('/')[1]);
            i += 100;
        } catch (e) {
            console.log("Wrong permissions.", e);
            return;
        }
    }
    return array;
}


//  |ilililiili|   |-----------|                       /\_____/\
// {|-[]----[]-|} /| BRAQUAGE  |                      /         \
//  |    \/    | / |-----------|                     |  ^    ^  |
//  |__________|                                     \   >-<   /
//     ||        '/,====                              \       |
//      ---------/                                     (      \____   |
//                                                     |           \  |
//                                                     | | |(      | /
//                                                     | | ||\     |/
//                                                    c_/c/c_c\___/
//
//
//
async function parse_web(match, tournamentId) {
    if (match.status != 'completed')
        return;

    const code_page = await axios.get(`https://organizer.toornament.com/tournaments/${tournamentId}/matches/${match.id}/tournament-code`, cookies);
    let $ = cheerio.load(code_page.data);
    match.codes = $(".button-clipboard").toArray().map((element) => { return element.attribs["data-clipboard-text"] });

    const link_page = await axios.get(`https://organizer.toornament.com/tournaments/${tournamentId}/matches/${match.id}/league-of-legends-stats`, cookies);
    $ = cheerio.load(link_page.data);
    match.links = $("[id^='match_set_status_collection_statuses']").toArray().map((element) => { return element.attribs.value });
}


async function riot_call(match) {
    match.data = [];
    for (let i in range(match.links.length)) {
        if (!match.links[i]) {
            match.data.push(null);
            match.links[i] = null;
            continue;
        }
        let matchId = match.links[i].split('/')[6];
        try {
            let res = await axios.get(`https://euw1.api.riotgames.com/lol/match/v4/matches/${matchId}/by-tournament-code/${match.codes[i]}?api_key=${riot_key}`);
            match.data.push(res.data);
        } catch (error) {
            match.data.push(null);
        }
    }
}


async function add_team_info(opponent, player) {
    await r.db('GL5').table('teams').filter({ name: opponent.name }).run().then(async(response) => {
        if (response.length == 0) {
            opponent.profileIcon = player.profileIcon;
            opponent.players = [player];
            r.db('GL5').table('teams').insert(opponent).run();
        } else {
            if (response[0].players.filter((p) => p.accountId == player.accountId).length != 0) {
                response[0].players.filter((p) => p.accountId == player.accountId)[0].summonerName = player.summonerName;
            } else
                response[0].players.push(player)
            await r.db('GL5').table('teams').filter({ name: opponent.name }).update({ players: response[0].players }).run();
        }
    });
}

async function add_player_info(identity, player_perf, match, i) {
    await r.db('GL5').table('playersFiltered').filter({ accountId: identity.accountId }).run().then(async(response) => {
        if (response.length == 0) {
            identity.region = match.tournament_name.split('-')[1].trim();
            identity.palier = match.tournament_name.split('-')[2].trim();
            identity.summonerName = identity.summonerName.trim();
            let n = 0;
            if (player_perf.stats.win)
                n = match.games[i].opponents.filter(op => op.result == 'win')[0].number;
            else
                n = match.games[i].opponents.filter(op => op.result == 'loss')[0].number;
            identity.participant = match.opponents.filter(op => op.number == n)[0].participant;
            identity.participant.region = identity.region;
            identity.participant.palier = identity.palier;
            identity.games = [player_perf];
            r.db('GL5').table('playersFiltered').insert(identity).run();
            await add_team_info(identity.participant, { summonerName: identity.summonerName, accountId: identity.accountId, profileIcon: identity.profileIcon })
        } else {
            if (response[0].games.filter((game) => game.gameId == match.gameId) != 0)
                return;
            response[0].games.push(player_perf)
            await r.db('GL5').table('playersFiltered').filter({ accountId: identity.accountId }).update({ profileIcon: identity.profileIcon }).run();
            await r.db('GL5').table('playersFiltered').filter({ accountId: identity.accountId }).update({ games: response[0].games }).run();
        }
    });
}

async function filter_all_games() {
    let i = 1;

    r.db('GL5').table('matches').run().then(async(response) => {
        for (let match of response) {
            for (let l = 0; l < match.data.length; l++) {
                let data = match.data[l];
                if (data === null)
                    continue;
                for (let i = 0; i < data.participantIdentities.length; i++) {
                    let identity = data.participantIdentities[i];
                    let player_perf = data.participants[i];
                    player_perf.gameId = data.gameId;
                    player_perf.gameCreation = data.gameCreation;
                    await add_player_info(identity.player, player_perf, match, l);
                }
            }
            console.log("Filtered match " + i + "/" + response.length);
            i++;
        }
    });
}

async function filter_games(matches) {
    if (matches.length == 0) {
        console.log("No new matches to filter.");
        return;
    }
    let i = 1;
    for (let match of matches) {
        for (let l = 0; l < match.data.length; l++) {
            let data = match.data[l];
            if (data === null)
                continue;
            for (let i = 0; i < data.participantIdentities.length; i++) {
                let identity = data.participantIdentities[i];
                let player_perf = data.participants[i];
                player_perf.gameId = data.gameId;
                player_perf.gameCreation = data.gameCreation;
                await add_player_info(identity.player, player_perf, match, l);
            }
        }
        console.log("Filtered match " + i + "/" + matches.length);
        i++;
    }
}

rl.on('line', async(input) => {
    if (input === "open") {
        opn("http://localhost:3003", { app: 'chrome' });
    } else if (input == 'filter') {
        await r.db('GL5').table('playersFiltered').delete().run();
        filter_all_games();
    } else if (input.startsWith("t")) {
        let tournaments = config.tournamentIds;
        for (let t of tournaments) {
            let t_info = await getTournamentInfo(t);

            let matches = await getMatches(t); //input.split(' ')[1]);
            let new_matches = [];
            matches = matches.filter((match) => match.status == 'completed')
            console.log("Found", matches.length, "completed matches.");
            let i = 0;
            for (let match of matches) {
                i++;
                let already_parsed = true;
                await r.db('GL5').table('matches').filter({ id: match.id }).run().then((response) => { if (response.length == 0) already_parsed = false });
                if (already_parsed) {
                    console.log("Match " + i + "/" + matches.length + " already parsed.");
                    continue;
                }
                match.tournament_name = t_info.name;
                match.tournament_id = t_info.id;
                match.tournament_full_name = t_info.full_name;
                if (match.status == 'completed') {
                    await parse_web(match, t);

                    await riot_call(match);
                    r.db('GL5').table('matches').insert(match).run();
                }
                new_matches.push(match);
                console.log("Match " + i + "/" + matches.length);
            }
            filter_games(new_matches);
        }
    }
});

/*r.db('GL5').table("matches").run().then(response => {
    for (let match of response) {
        if (match.opponents.filter(op => op.participant.name == "Brest of 5").length != 0) {
            console.log(match);

            match.data.forEach(d => {
                if (d && false) {
                    for (let i = 0; i < d.participantIdentities.length; i++) {
                        if ((d.participants[i].stats.win && match.opponents.filter(op => op.participant.name == "Brest of 5")[0].result == 'win')
                            || (!d.participants[i].stats.win && match.opponents.filter(op => op.participant.name == "Brest of 5")[0].result == 'loss')) {
                            console.log(d.participantIdentities[i], d.participants[i].stats.win, match.opponents.filter(op => op.participant.name == "Brest of 5")[0].result);
                        }
                    }
                }
            });
        }
    }
});*/