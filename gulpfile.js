var _ = require('lodash');
var gulp = require('gulp');
var stripJsonComments = require('strip-json-comments');
var gutil = require('gulp-util');
var bower = require('bower');
var ngAnnotate = require('gulp-ng-annotate');
var concat = require('gulp-concat');
var sass = require('gulp-sass');
var minifyCss = require('gulp-minify-css');
var rename = require('gulp-rename');
var sh = require('shelljs');
var gitRev = require('git-rev');
var template = require('gulp-template');
var uglify = require('gulp-uglify');
var fs = require('fs');
var Q = require('q');
var gulpif = require('gulp-if');
var notifier = require('node-notifier');
var fontello = require('gulp-fontello');
var clean = require('gulp-clean');
var path = require('path');

var isWatch = false;

/**
 * helper to wrap a stream with a promise for easy chaining
 * @param stream
 * @returns {Q.Promise}
 */
var streamAsPromise = function(stream) {
    var def = Q.defer();

    stream
        .on('end', function() {
            def.resolve();
        })
        .on('error', function(e) {
            def.reject(e);
        })
    ;

    return def.promise;
};

/**
 * build appconfig from .json files
 *
 * @returns {Q.Promise}
 */
var buildAppConfig = function() {
    var def = Q.defer();
    var p = def.promise;

    gitRev.branch(function(branch) {
        gitRev.short(function(rev) {
            var config = {
                VERSION: branch + ":" + rev
            };

            ['./appconfig.json', './appconfig.default.json'].forEach(function(filename) {
                var json = fs.readFileSync(filename);

                if (json) {
                    var data = JSON.parse(stripJsonComments(json.toString('utf8')));
                    config = _.defaults(config, data);
                }
            });

            if (typeof config.API_HTTPS !== "undefined" && config.API_HTTPS === false) {
                config.API_URL = "http://" + config.API_HOST;
            } else {
                config.API_URL = "https://" + config.API_HOST;
            }

            def.resolve(config);
        });
    });

    return p;
};

var appConfig = Q.fcall(buildAppConfig);

gulp.task('appconfig', function() {
    // update global promise with a rebuild
    appConfig = Q.fcall(buildAppConfig);
    return appConfig;
});

gulp.task('templates:index', ['appconfig'], function() {
    var readTranslations = function(filename) {
        var def = Q.defer();

        fs.readFile(filename, function(err, raw) {
            if (!raw) {
                throw new Error("Missing translations!");
            }

            def.resolve(JSON.parse(stripJsonComments(raw.toString('utf8'))));
        });

        return def.promise;
    };

    return appConfig.then(function(APPCONFIG) {
        var translations = {
            'mobile': {}
        };

        return Q.all(_.map([
            './src/translations/translations/english.json',
            './src/translations/translations/americanEnglish.json',
            './src/translations/translations/french.json',
            './src/translations/translations/dutch.json',
            './src/translations/translations/chinese.json',
            './src/translations/translations/spanish.json',
            './src/translations/translations/russian.json',

            './src/translations/translations/mobile/english.json',
            './src/translations/translations/mobile/americanEnglish.json',
            './src/translations/translations/mobile/french.json',
            './src/translations/translations/mobile/dutch.json',
            './src/translations/translations/mobile/chinese.json',
            './src/translations/translations/mobile/spanish.json',
            './src/translations/translations/mobile/russian.json'
        ], function(filename) {
            var language = path.basename(filename, '.json');
            var isMobile = filename.indexOf('mobile/') !== -1;

            return readTranslations(filename).then(function(result) {
                if (isMobile) {
                    translations['mobile'][language] = result;
                } else {
                    translations[language] = result;
                }
            })
        })).then(function() {
            return streamAsPromise(gulp.src("./src/index.html")
                .pipe(template({
                    CSP: APPCONFIG.DEBUG ? ['*'] : ['api.blocktrail.com'],
                    VERSION: APPCONFIG.VERSION,
                    APPCONFIG: APPCONFIG,
                    APPCONFIG_JSON: JSON.stringify(APPCONFIG),
                    NG_CORDOVA_MOCKS: APPCONFIG.NG_CORDOVA_MOCKS,
                    TRANSLATIONS: JSON.stringify(translations)
                }))
                .pipe(gulp.dest("./www"))
            );
        });
    });
});

gulp.task('templates:rest', ['appconfig'], function() {

    return appConfig.then(function(APPCONFIG) {
        return streamAsPromise(gulp.src(["./src/templates/*", "./src/templates/**/*"])
            .pipe(gulp.dest("./www/templates"))
        );
    });
});

gulp.task('js:ng-cordova', ['appconfig'], function() {

    return appConfig.then(function(APPCONFIG) {
        var files = ['./src/lib/ngCordova/dist/ng-cordova.js'];

        if (APPCONFIG.NG_CORDOVA_MOCKS) {
            files.push("./src/lib/ngCordova/dist/ng-cordova-mocks.js");
        }

        return streamAsPromise(gulp.src(files)
            .pipe(concat('ng-cordova.js'))
            .pipe(gulpif(APPCONFIG.MINIFY, uglify()))
            .pipe(gulp.dest('./www/js/'))
        );
    });
});

gulp.task('js:libs', ['appconfig'], function() {

    return appConfig.then(function(APPCONFIG) {
        return streamAsPromise(gulp.src([
            "./src/lib/q/q.js",
            "./src/lib/ionic/release/js/ionic.bundle.js",
            "./src/lib/pouchdb/dist/pouchdb.js",

            "./src/lib/angulartics/src/angulartics.js",
            "./src/lib/angulartics/src/angulartics-ga-cordova-google-analytics-plugin.js",

            "./src/lib/browserify-cryptojs/components/core.js",
            "./src/lib/browserify-cryptojs/components/x64-core.js",
            "./src/lib/browserify-cryptojs/components/sha256.js",
            "./src/lib/browserify-cryptojs/components/sha512.js",
            "./src/lib/browserify-cryptojs/components/enc-base64.js",
            "./src/lib/browserify-cryptojs/components/md5.js",
            "./src/lib/browserify-cryptojs/components/evpkdf.js",
            "./src/lib/browserify-cryptojs/components/cipher-core.js",
            "./src/lib/browserify-cryptojs/components/aes.js",

            "./src/lib/angular-translate/angular-translate.js",
            "./src/lib/libphonenumber/dist/libphonenumber.js",
            "./src/lib/intl-tel-input/src/js/data.js",

            "./src/lib/moment/moment.js",
            "./src/lib/moment/locale/nl.js",
            "./src/lib/moment/locale/fr.js",
            "./src/lib/moment/locale/es.js",
            "./src/lib/moment/locale/ru.js",
            "./src/lib/moment/locale/zh-cn.js",
            "./src/lib/angular-moment/angular-moment.js",
            "./src/lib/ngImgCrop/compile/unminified/ng-img-crop.js",
            "./src/lib/qrcode/lib/qrcode.js",
            "./src/lib/angular-qr/src/angular-qr.js"
        ])
            .pipe(concat('libs.js'))
            .pipe(gulpif(APPCONFIG.MINIFY, uglify()))
            .pipe(gulp.dest('./www/js/'))
        );
    });
});

gulp.task('js:app', ['appconfig'], function() {

    return appConfig.then(function(APPCONFIG) {
        return streamAsPromise(gulp.src([
            './src/js/**/*.js',
        ])
            .pipe(concat('app.js'))
            .pipe(ngAnnotate())
            .on('error', function(e) {
                if (isWatch) {
                    notifier.notify({
                        title: 'GULP watch + js:app + ngAnnotate ERR',
                        message: e.message
                    });
                    console.error(e);
                    this.emit('end');
                } else {
                    throw e;
                }
            })
            .pipe(gulpif(APPCONFIG.MINIFY, uglify()))
            .pipe(gulp.dest('./www/js/'))
        );
    });
});

gulp.task('js:sdk', ['appconfig'], function() {

    return appConfig.then(function(APPCONFIG) {

        return streamAsPromise(gulp.src([
            "./src/lib/blocktrail-sdk/build/blocktrail-sdk-full.js"
        ])
            .pipe(concat('sdk.js'))
            .pipe(gulpif(APPCONFIG.MINIFY, uglify({
                mangle: {
                    except: ['Buffer', 'BigInteger', 'Point', 'Script', 'ECPubKey', 'ECKey']
                }
            })))
            .pipe(gulp.dest('./www/js/'))
        );
    });
});

var sassTask = function() {
    return appConfig.then(function(APPCONFIG) {
        return streamAsPromise(gulp.src('./src/scss/ionic.app.scss')
            .pipe(sass({errLogToConsole: true}))
            .pipe(gulp.dest('./www/css/'))
            .pipe(gulpif(APPCONFIG.MINIFY, minifyCss({keepSpecialComments: 0})))
            .pipe(gulp.dest('./www/css/'))
        );
    });
};

// create a sass with and without dependancy on fontello
gulp.task('sass', ['appconfig'], sassTask);
gulp.task('sassfontello', ['appconfig', 'fontello'], sassTask);


gulp.task('fontello-dl', function() {

    return gulp.src('./fontello-config.json')
        .pipe(fontello())
        .pipe(gulp.dest('./www/fontello/'))
    ;
});

gulp.task('fontello-rename', ['fontello-dl'], function() {

    return gulp.src(['./www/fontello/css/fontello-codes.css'])
        .pipe(rename('fontello-codes.scss'))
        .pipe(gulp.dest('./www/fontello/css'))
    ;
});

gulp.task('fontello-clean', ['fontello-rename'], function() {

    return gulp.src(['./www/fontello/css/*.css'])
        .pipe(clean());
});

gulp.task('fontello', ['fontello-dl', 'fontello-rename', 'fontello-clean'], function() {

    return gulp.src('./www/fontello/font/*')
        .pipe(gulp.dest('./www/fonts'))
    ;
});

gulp.task('copyfonts', ['appconfig'], function() {

    return appConfig.then(function(APPCONFIG) {
        return streamAsPromise(gulp.src('./src/lib/ionic/release/fonts/**/*.{ttf,woff,eof,eot,svg}')
            .pipe(gulp.dest('./www/fonts'))
        );
    });
});

gulp.task('watch', function() {
    isWatch = true;

    gulp.watch(['./src/scss/**/*.scss'], ['sass']);
    gulp.watch(['./src/js/**/*.js'], ['js:app']);
    gulp.watch(['./src/lib/**/*.js'], ['js:libs', 'js:sdk', 'js:ng-cordova']);
    gulp.watch(['./src/templates/**/*', './src/translations/translations/*', './src/translations/translations/mobile/*', './src/index.html'], ['templates']);
    gulp.watch(['./appconfig.json', './appconfig.default.json'], ['default']);
});

gulp.task('js', ['js:libs', 'js:app', 'js:ng-cordova', 'js:sdk']);
gulp.task('templates', ['templates:index', 'templates:rest']);
gulp.task('default', ['sassfontello', 'templates', 'js', 'copyfonts']);
gulp.task('nofontello', ['sass', 'templates', 'js', 'copyfonts']);
