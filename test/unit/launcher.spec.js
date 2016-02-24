import Promise from 'bluebird'
import di from 'di'
import events from '../../lib/events'
import launcher from '../../lib/launcher'
import createMockTimer from './mocks/timer'

// promise mock
var stubPromise = (obj, method, stubAction) => {
  var promise = new Promise((resolve) => {
    obj[method].resolve = resolve
  })

  sinon.stub(obj, method, () => {
    if (stubAction) stubAction()

    return promise
  })
}

class FakeBrowser {
  constructor (id, name, baseBrowserDecorator) {
    this.id = id
    this.name = name
    baseBrowserDecorator(this)
    FakeBrowser._instances.push(this)
    sinon.stub(this, 'start', () => {
      this.state = this.STATE_BEING_CAPTURED
      this._done()
    })
    stubPromise(this, 'forceKill')
    sinon.stub(this, 'restart')
  }
}

class ScriptBrowser {
  constructor (id, name, baseBrowserDecorator) {
    this.id = id
    this.name = name
    baseBrowserDecorator(this)
    ScriptBrowser._instances.push(this)
    sinon.stub(this, 'start', () => {
      this.state = this.STATE_BEING_CAPTURED
      this._done()
    })
    stubPromise(this, 'forceKill')
    sinon.stub(this, 'restart')
  }
}

describe.only('launcher', () => {
  // mock out id generator
  var lastGeneratedId = null
  launcher.Launcher.generateId = () => {
    return ++lastGeneratedId
  }

  before(() => {
    Promise.setScheduler((fn) => fn())
  })

  after(() => {
    Promise.setScheduler((fn) => process.nextTick(fn))
  })

  beforeEach(() => {
    lastGeneratedId = 0
    FakeBrowser._instances = []
    ScriptBrowser._instances = []
  })

  describe('Launcher', () => {
    var emitter
    var l = emitter = null
    var config

    beforeEach(() => {
      emitter = new events.EventEmitter()
      config = {
        captureTimeout: 0,
        protocol: 'http:',
        hostname: 'localhost',
        port: 1234,
        urlRoot: '/root/'
      }
      var injector = new di.Injector([{
        'launcher:Fake': ['type', FakeBrowser],
        'launcher:Script': ['type', ScriptBrowser],
        'emitter': ['value', emitter],
        'config': ['value', config],
        'timer': ['factory', createMockTimer]
      }])
      l = new launcher.Launcher(emitter, injector)
    })

    describe('launch', () => {
      it('should inject and start all browsers', (done) => {
        l.launch(['Fake'], 1)

        var browser = FakeBrowser._instances.pop()
        l.jobs.on('end', () => {
          expect(browser.start).to.have.been.calledWith('http://localhost:1234/root/')
          expect(browser.id).to.equal(lastGeneratedId)
          expect(browser.name).to.equal('Fake')
          done()
        })
      })

      it('should allow launching a script', (done) => {
        l.launch(['/usr/local/bin/special-browser'], 1)

        var script = ScriptBrowser._instances.pop()

        l.jobs.on('end', () => {
          expect(script.start).to.have.been.calledWith('http://localhost:1234/')
          expect(script.name).to.equal('/usr/local/bin/special-browser')

          done()
        })
      })

      it('should use the non default host', (done) => {
        config.hostname = 'whatever'
        l.launch(['Fake'], 1)

        var browser = FakeBrowser._instances.pop()
        l.jobs.on('end', () => {
          expect(browser.start).to.have.been.calledWith('http://whatever:1234/root/')
          done()
        })
      })

      it('should only launch the specified number of browsers at once', (done) => {
        l.launch([
          'Fake',
          'Fake',
          'Fake'
        ], 2)

        var b1 = FakeBrowser._instances.pop()
        var b2 = FakeBrowser._instances.pop()
        var b3 = FakeBrowser._instances.pop()

        setTimeout(() => {
          expect(b1.start).to.not.have.been.called
          expect(b2.start).to.have.been.calledOnce
          expect(b3.start).to.have.been.calledOnce

          b1._done()
          b2._done()

          expect(b1.start).to.have.been.calledOnce
          l.jobs.on('done', done)
        }, 1)
      })
    })

    describe('restart', () => {
      it('should restart the browser', () => {
        l.launch(['Fake'], 1)
        var browser = FakeBrowser._instances.pop()

        var returnedValue = l.restart(lastGeneratedId)
        expect(returnedValue).to.equal(true)
        expect(browser.restart).to.have.been.called
      })

      it('should return false if the browser was not launched by launcher (manual)', () => {
        l.launch([], 1)
        expect(l.restart('manual-id')).to.equal(false)
      })
    })

    describe('kill', () => {
      it('should kill browser with given id', (done) => {
        l.launch(['Fake'], 1)
        var browser = FakeBrowser._instances.pop()

        l.kill(browser.id, done)
        expect(browser.forceKill).to.have.been.called

        browser.forceKill.resolve()
      })

      it('should return false if browser does not exist, but still resolve the callback', (done) => {
        l.launch(['Fake'], 1)
        var browser = FakeBrowser._instances.pop()

        var returnedValue = l.kill('weird-id', done)
        expect(returnedValue).to.equal(false)
        expect(browser.forceKill).not.to.have.been.called
      })

      it('should not require a callback', (done) => {
        l.launch(['Fake'], 1)
        FakeBrowser._instances.pop()

        l.kill('weird-id')
        process.nextTick(done)
      })
    })

    describe('killAll', () => {
      it('should kill all running processe', () => {
        l.launch(['Fake', 'Fake'], 1)
        l.killAll()

        var browser = FakeBrowser._instances.pop()
        expect(browser.forceKill).to.have.been.called

        browser = FakeBrowser._instances.pop()
        expect(browser.forceKill).to.have.been.called
      })

      it('should call callback when all processes killed', () => {
        var exitSpy = sinon.spy()

        l.launch(['Fake', 'Fake'], 1)
        l.killAll(exitSpy)

        expect(exitSpy).not.to.have.been.called

        // finish the first browser
        var browser = FakeBrowser._instances.pop()
        browser.forceKill.resolve()

        scheduleNextTick(() => {
          expect(exitSpy).not.to.have.been.called
        })

        scheduleNextTick(() => {
          // finish the second browser
          browser = FakeBrowser._instances.pop()
          browser.forceKill.resolve()
        })

        scheduleNextTick(() => {
          expect(exitSpy).to.have.been.called
        })
      })

      it('should call callback even if no browsers lanunched', (done) => {
        l.killAll(done)
      })
    })

    describe('areAllCaptured', () => {
      it('should return true if only if all browsers captured', (done) => {
        l.launch(['Fake', 'Fake'], 2)

        l.jobs.on('end', () => {
          expect(l.areAllCaptured()).to.equal(false)

          l.markCaptured(1)
          expect(l.areAllCaptured()).to.equal(false)

          l.markCaptured(2)
          expect(l.areAllCaptured()).to.equal(true)

          done()
        })
      })
    })

    describe('onExit', () => {
      it('should kill all browsers', (done) => {
        l.launch(['Fake', 'Fake'], 1)

        emitter.emitAsync('exit').then(done)

        var browser = FakeBrowser._instances.pop()
        browser.forceKill.resolve()

        browser = FakeBrowser._instances.pop()
        browser.forceKill.resolve()
      })
    })
  })
})
